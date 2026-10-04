import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config";
import { getRedis } from "./redis";
import { logger } from "./logger";
import { jwtService } from "../services/jwt";
import { sharedIdentityRepo, sharedOrderRepo } from "../repositories/shared";
import { assertRestaurantAccess } from "../middleware/vendorAccess";

// ============================================
// WebSocket Server (EOS Layer 1, P05 Live Kitchen)
// Integrated with Express via HTTP upgrade.
// Redis PubSub for cross-instance broadcasting.
// Contract: { event: "ORDER_STATUS_UPDATE", data: { order_id, sql_status, ui_status } }
//
// Security: connections are authenticated (httpOnly access cookie or
// Authorization: Bearer). Query-string `?token=` is never accepted.
// After cryptographic access-token validation, the durable identity
// repository is the authorization source (current role, suspension,
// deletion). Subscriptions and protected deliveries revalidate identity
// and resource authorization on this instance before any payload is sent.
//   - subscribe_restaurant  -> vendor of that restaurant, or platform ops
//   - subscribe (order)     -> the order's owner, vendor of its restaurant,
//                              or platform ops
// ============================================

export interface OrderStatusUpdate {
  event: "ORDER_STATUS_UPDATE";
  data: {
    order_id: string;
    restaurant_id: string;
    sql_status: string;
    ui_status: string;
    timestamp: string;
  };
}

const UI_STATUS_MAP: Record<string, string> = {
  CONFIRMED: "Order Confirmed",
  PREPARING: "Preparing",
  ALMOST_READY: "Almost Ready",
  READY_FOR_PICKUP: "Ready for Pickup",
  PICKED_UP: "Picked Up",
  PAYMENT_FAILED: "Payment Failed",
  CANCELLED: "Cancelled",
};

const PUBSUB_CHANNEL = "order_updates";

const PLATFORM_ROLES = new Set(["ADMIN", "SUPER_ADMIN", "OPS_AGENT"]);
const VENDOR_ROLES = new Set(["VENDOR_OWNER", "VENDOR_STAFF"]);

let wss: WebSocketServer | null = null;

interface WsPrincipal {
  sub: string;
  role: string;
}

interface ClientInfo {
  ws: WebSocket;
  subscriptions: Set<string>;
  userId: string;
}

const clients = new Map<string, ClientInfo>();

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function extractHandshakeToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[config.jwt.accessCookieName] ?? null;
}

async function resolveActivePrincipal(userId: string): Promise<WsPrincipal | null> {
  const user = await sharedIdentityRepo.getById(userId).catch(() => null);
  if (!user || user.is_suspended) return null;
  return { sub: user.id, role: user.role };
}

function revokeClient(clientId: string, info: ClientInfo): void {
  info.subscriptions.clear();
  clients.delete(clientId);
  if (
    info.ws.readyState === WebSocket.OPEN ||
    info.ws.readyState === WebSocket.CONNECTING
  ) {
    info.ws.close(1008, "Unauthorized");
  }
}

async function canSubscribeOrder(
  principal: WsPrincipal,
  orderId: string,
): Promise<boolean> {
  if (PLATFORM_ROLES.has(principal.role)) return true;

  const order = await sharedOrderRepo.getById(orderId).catch(() => null);
  if (!order) return false;

  if (principal.role === "CONSUMER") {
    return order.user_id === principal.sub;
  }

  if (VENDOR_ROLES.has(principal.role)) {
    try {
      await assertRestaurantAccess(
        { locals: { userId: principal.sub, userRole: principal.role } },
        order.restaurant_id,
      );
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function canSubscribeRestaurant(
  principal: WsPrincipal,
  restaurantId: string,
): Promise<boolean> {
  if (PLATFORM_ROLES.has(principal.role)) return true;
  if (!VENDOR_ROLES.has(principal.role)) return false;

  try {
    await assertRestaurantAccess(
      { locals: { userId: principal.sub, userRole: principal.role } },
      restaurantId,
    );
    return true;
  } catch {
    return false;
  }
}

export function initWebSocketServer(httpServer: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const token = extractHandshakeToken(req);
    if (!token) {
      logger.warn({ message: "ws_connection_rejected_unauthenticated" });
      ws.close(1008, "Unauthorized");
      return;
    }

    let claims: { sub: string };
    try {
      claims = jwtService.verifyAccessToken(token);
    } catch {
      logger.warn({ message: "ws_connection_rejected_unauthenticated" });
      ws.close(1008, "Unauthorized");
      return;
    }

    void (async () => {
      const principal = await resolveActivePrincipal(claims.sub);
      if (!principal) {
        logger.warn({ message: "ws_connection_rejected_unauthenticated" });
        ws.close(1008, "Unauthorized");
        return;
      }

      const clientId = randomUUID();
      const info: ClientInfo = {
        ws,
        subscriptions: new Set(),
        userId: principal.sub,
      };
      clients.set(clientId, info);

      logger.info({
        message: "ws_client_connected",
        client_id: clientId,
        role: principal.role,
      });

      ws.on("message", (raw) => {
        let msg: { type?: string; order_id?: string; restaurant_id?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "subscribe" && msg.order_id) {
          const orderId = msg.order_id;
          void (async () => {
            const current = await resolveActivePrincipal(info.userId);
            if (!current) {
              revokeClient(clientId, info);
              return;
            }
            const allowed = await canSubscribeOrder(current, orderId);
            if (allowed) info.subscriptions.add(`order:${orderId}`);
          })();
        }
        if (msg.type === "subscribe_restaurant" && msg.restaurant_id) {
          const restaurantId = msg.restaurant_id;
          void (async () => {
            const current = await resolveActivePrincipal(info.userId);
            if (!current) {
              revokeClient(clientId, info);
              return;
            }
            const allowed = await canSubscribeRestaurant(current, restaurantId);
            if (allowed) info.subscriptions.add(`restaurant:${restaurantId}`);
          })();
        }
      });

      ws.on("close", () => {
        clients.delete(clientId);
        logger.info({ message: "ws_client_disconnected", client_id: clientId });
      });
    })();
  });

  if (config.env !== "test") {
    const sub = getRedis().duplicate();
    sub.subscribe(PUBSUB_CHANNEL, () => {}).catch(() => {
      logger.warn({ message: "redis_pubsub_subscribe_failed" });
    });
    sub.on("message", (_channel, message) => {
      try {
        const update: OrderStatusUpdate = JSON.parse(String(message));
        void broadcast(update);
      } catch {
        // ignore
      }
    });
  }

  logger.info({ message: "websocket_server_started" });
  return wss;
}

export async function broadcast(update: OrderStatusUpdate): Promise<void> {
  const payload = JSON.stringify(update);

  for (const [clientId, client] of [...clients]) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    const matchesOrder = client.subscriptions.has(`order:${update.data.order_id}`);
    const matchesRestaurant = client.subscriptions.has(
      `restaurant:${update.data.restaurant_id}`,
    );
    if (!matchesOrder && !matchesRestaurant) continue;

    const principal = await resolveActivePrincipal(client.userId);
    if (!principal) {
      revokeClient(clientId, client);
      continue;
    }

    let authorized = false;
    if (matchesOrder) {
      authorized = await canSubscribeOrder(principal, update.data.order_id);
    }
    if (!authorized && matchesRestaurant) {
      authorized = await canSubscribeRestaurant(principal, update.data.restaurant_id);
    }
    if (!authorized) {
      revokeClient(clientId, client);
      continue;
    }

    client.ws.send(payload);
  }
}

export async function publishStatusUpdate(
  update: { order_id: string; restaurant_id: string; status: string },
): Promise<void> {
  const fullUpdate: OrderStatusUpdate = {
    event: "ORDER_STATUS_UPDATE",
    data: {
      order_id: update.order_id,
      restaurant_id: update.restaurant_id,
      sql_status: update.status,
      ui_status: UI_STATUS_MAP[update.status] ?? update.status,
      timestamp: new Date().toISOString(),
    },
  };

  await broadcast(fullUpdate);

  if (config.env !== "test") {
    try {
      const redis = getRedis();
      await redis.publish(PUBSUB_CHANNEL, JSON.stringify(fullUpdate));
    } catch {
      logger.warn({ message: "redis_publish_failed" });
    }
  }
}

export function buildUiStatus(sqlStatus: string): string {
  return UI_STATUS_MAP[sqlStatus] ?? sqlStatus;
}
