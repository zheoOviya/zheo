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

export function useWebSocket(orderId: string | null) {
  // Subscribe reactively to the access token. The auth store rotates the token
  // in memory (login / refresh / logout); a token change must recreate the
  // socket so the authenticated handshake and the `?token=` fallback stay
  // current. `store.ts` and `AuthGate.tsx` are intentionally untouched.
  const accessToken = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<number>(0);
  // Monotonic lifecycle generation. Every effect run (mount, orderId change,
  // token change, StrictMode replay) increments this and supersedes all prior
  // generations. A stale socket callback whose generation is no longer current
  // is inert: it can neither mutate state nor schedule work.
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

    // Tear down the socket owned by this lifecycle and detach its callbacks so
    // a late close/error cannot act on behalf of a superseded generation.
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
      if (!isCurrent() || !orderId || accessToken === null) return;
      if (wsRef.current) return;

      // Same-origin connections carry the httpOnly access cookie; cross-origin
      // dev connections use the in-memory token as a query parameter.
      const sep = WS_URL.includes("?") ? "&" : "?";
      const url = `${WS_URL}${sep}token=${encodeURIComponent(accessToken)}`;
      const ws = new WebSocket(url);
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

      ws.onclose = () => {
        if (!isCurrent() || wsRef.current !== ws) return;
        wsRef.current = null;
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (!isCurrent() || wsRef.current !== ws) return;
        ws.close();
      };
    }

    // Fresh retry budget per lifecycle, and never leak the previous
    // lifecycle's pending reconnect.
    retryRef.current = 0;
    clearTimer();

    if (!orderId || accessToken === null) {
      // No authenticated connection path: close and do not open.
      detachAndClose();
      setConnected(false);
    } else {
      open();
    }

    return () => {
      // Supersede this lifecycle first so any in-flight callback from its
      // socket is already inert before teardown completes.
      generationRef.current += 1;
      detachAndClose();
      setConnected(false);
    };
  }, [orderId, accessToken]);

  return { status, connected };
}
