"use client";

import { useEffect, useRef, useState } from "react";
import { getWsUrl } from "@snakzap/config/ws";
import { useAuthStore } from "../lib/store";

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
const POLICY_CLOSE_CODE = 1008;

export function useWebSocket(orderId: string | null) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<number>(0);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    const isCurrent = () => generationRef.current === generation;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const detachAndClose = () => {
      clearTimer();
      const socket = wsRef.current;
      wsRef.current = null;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    };

    const scheduleReconnect = () => {
      if (!isCurrent()) return;
      if (retryRef.current >= MAX_RETRIES) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const delay = Math.min(
        BASE_RETRY_MS * 2 ** retryRef.current,
        MAX_RETRY_MS,
      );
      retryRef.current += 1;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!isCurrent()) return;
        open();
      }, delay);
    };

    function open() {
      if (!isCurrent() || !orderId) return;
      if (wsRef.current) return;

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isCurrent() || wsRef.current !== ws) return;
        retryRef.current = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", order_id: orderId }));
      };

      ws.onmessage = (event) => {
        if (!isCurrent() || wsRef.current !== ws) return;
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

      ws.onclose = (event) => {
        if (!isCurrent() || wsRef.current !== ws) return;
        wsRef.current = null;
        setConnected(false);
        if (event?.code === POLICY_CLOSE_CODE) return;
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (!isCurrent() || wsRef.current !== ws) return;
        ws.close();
      };
    }

    retryRef.current = 0;
    clearTimer();

    if (!orderId) {
      detachAndClose();
      setConnected(false);
    } else {
      open();
    }

    return () => {
      generationRef.current += 1;
      detachAndClose();
      setConnected(false);
    };
  }, [orderId, accessToken]);

  return { status, connected };
}
