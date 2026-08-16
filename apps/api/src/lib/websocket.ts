import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config";
import { getRedis } from "./redis";
import { logger } from "./logger";
import { jwtService } from "../services/jwt";
import { sharedOrderRepo } from "../repositories/shared";
import { assertRestaurantAccess } from "../middleware/vendorAccess";

// ============================================
// WebSocket Server (EOS Layer 1, P05 Live Kitchen)
// Integrated with Express via HTTP upgrade.
// Redis PubSub for cross-instance broadcasting.
// Contract: { event: "ORDER_STATUS_UPDATE", data: { order_id, sql_status, ui_status } }
//
// Security: connections are authenticated (httpOnly access cookie, `?token=`
// query, or Authorization header) and subscriptions are authorized:
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

interface WsClaims {
  sub: string;
  role: string;
}

interface ClientInfo {
  ws: WebSocket;
  subscriptions: Set<string>;
  claims: WsClaims;
}

// All connected clients with their subscriptions
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

function authenticateConnection(req: IncomingMessage): WsClaims | null {
  let token: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (!token) {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      token = url.searchParams.get("token");
    } catch {
      token = null;
    }
  }

  if (!token) {
    const cookies = parseCookieHeader(req.headers.cookie);
    token = cookies[config.jwt.accessCookieName] ?? null;
  }

  if (!token) return null;

  try {
    const claims = jwtService.verifyAccessToken(token);
    return { sub: claims.sub, role: claims.role };
  } catch {
    return null;
  }
}

async function canSubscribeOrder(
  claims: WsClaims,
  orderId: string,
): Promise<boolean> {
  if (PLATFORM_ROLES.has(claims.role)) return true;

  const order = await sharedOrderRepo.getById(orderId).catch(() => null);
  if (!order) return false;

  if (claims.role === "CONSUMER") {
    return order.user_id === claims.sub;
  }

  if (VENDOR_ROLES.has(claims.role)) {
    try {
      await assertRestaurantAccess(
        { locals: { userId: claims.sub, userRole: claims.role } },
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
  claims: WsClaims,
  restaurantId: string,
): Promise<boolean> {
  if (PLATFORM_ROLES.has(claims.role)) return true;
  if (!VENDOR_ROLES.has(claims.role)) return false;

  try {
    await assertRestaurantAccess(
      { locals: { userId: claims.sub, userRole: claims.role } },
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
    const claims = authenticateConnection(req);
    if (!claims) {
      logger.warn({ message: "ws_connection_rejected_unauthenticated" });
      ws.close(1008, "Unauthorized");
      return;
    }

    const clientId = randomUUID();
    const info: ClientInfo = { ws, subscriptions: new Set(), claims };
    clients.set(clientId, info);

    logger.info({
      message: "ws_client_connected",
      client_id: clientId,
      role: claims.role,
    });

    ws.on("message", (raw) => {
      let msg: { type?: string; order_id?: string; restaurant_id?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "subscribe" && msg.order_id) {
        void canSubscribeOrder(claims, msg.order_id).then((allowed) => {
          if (allowed) info.subscriptions.add(`order:${msg.order_id}`);
        });
      }
      if (msg.type === "subscribe_restaurant" && msg.restaurant_id) {
        void canSubscribeRestaurant(claims, msg.restaurant_id).then((allowed) => {
          if (allowed) info.subscriptions.add(`restaurant:${msg.restaurant_id}`);
        });
      }
    });

    ws.on("close", () => {
      clients.delete(clientId);
      logger.info({ message: "ws_client_disconnected", client_id: clientId });
    });
  });

  // Subscribe to Redis PubSub for cross-instance broadcasting
  if (config.env !== "test") {
    const sub = getRedis().duplicate();
    sub.subscribe(PUBSUB_CHANNEL, () => {}).catch(() => {
      logger.warn({ message: "redis_pubsub_subscribe_failed" });
    });
    sub.on("message", (_channel, message) => {
      try {
        const update: OrderStatusUpdate = JSON.parse(String(message));
        broadcast(update);
      } catch {
        // ignore
      }
    });
  }

  logger.info({ message: "websocket_server_started" });
  return wss;
}

export function broadcast(update: OrderStatusUpdate): void {
  const payload = JSON.stringify(update);

  for (const [, client] of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    const matchesOrder = client.subscriptions.has(`order:${update.data.order_id}`);
    const matchesRestaurant = client.subscriptions.has(
      `restaurant:${update.data.restaurant_id}`,
    );

    if (matchesOrder || matchesRestaurant) {
      client.ws.send(payload);
    }
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

  // Broadcast locally (single-instance)
  broadcast(fullUpdate);

  // Publish to Redis for other instances
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
