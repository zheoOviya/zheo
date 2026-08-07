import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config";
import { getRedis } from "./redis";
import { logger } from "./logger";

// ============================================
// WebSocket Server (EOS Layer 1, P05 Live Kitchen)
// Integrated with Express via HTTP upgrade.
// Redis PubSub for cross-instance broadcasting.
// Contract: { event: "ORDER_STATUS_UPDATE", data: { order_id, sql_status, ui_status } }
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

let wss: WebSocketServer | null = null;

interface ClientInfo {
  ws: WebSocket;
  subscriptions: Set<string>;
}

// All connected clients with their subscriptions
const clients = new Map<string, ClientInfo>();

export function initWebSocketServer(httpServer: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const clientId = randomUUID();
    const info: ClientInfo = { ws, subscriptions: new Set() };
    clients.set(clientId, info);

    logger.info({ message: "ws_client_connected", client_id: clientId });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.order_id) {
          info.subscriptions.add(`order:${msg.order_id}`);
        }
        if (msg.type === "subscribe_restaurant" && msg.restaurant_id) {
          info.subscriptions.add(`restaurant:${msg.restaurant_id}`);
        }
      } catch {
        // ignore malformed
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
    sub.subscribe(PUBSUB_CHANNEL).catch(() => {
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
