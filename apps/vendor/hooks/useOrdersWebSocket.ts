"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/v1/ws`
    : "ws://localhost:3001/api/v1/ws");

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

export function useOrdersWebSocket(restaurantId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [updates, setUpdates] = useState<OrderStatusUpdate[]>([]);
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (!restaurantId || wsRef.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(
        JSON.stringify({
          type: "subscribe_restaurant",
          restaurant_id: restaurantId,
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const update: OrderStatusUpdate = JSON.parse(event.data);
        if (update.event === "ORDER_STATUS_UPDATE") {
          setUpdates((prev) => [update, ...prev].slice(0, 50));
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [restaurantId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { updates, connected };
}
