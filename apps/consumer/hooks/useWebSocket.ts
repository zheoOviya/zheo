"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getWsUrl } from "@snakzap/config/ws";

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

const WS_URL = getWsUrl("/api/v1/ws");

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const MAX_RETRIES = 10;

export function useWebSocket(orderId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!orderId || wsRef.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setConnected(true);
      ws.send(JSON.stringify({ type: "subscribe", order_id: orderId }));
    };

    ws.onmessage = (event) => {
      try {
        const update: OrderStatusUpdate = JSON.parse(event.data);
        if (
          update.event === "ORDER_STATUS_UPDATE" &&
          update.data.order_id === orderId
        ) {
          setStatus(update.data.sql_status);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Exponential backoff reconnect with a cap on attempts.
      if (retryRef.current < MAX_RETRIES) {
        const delay = Math.min(
          BASE_RETRY_MS * 2 ** retryRef.current,
          MAX_RETRY_MS,
        );
        retryRef.current += 1;
        timerRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [orderId]);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      retryRef.current = MAX_RETRIES;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { status, connected };
}
