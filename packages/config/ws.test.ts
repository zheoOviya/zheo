import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWsUrl } from "./ws";

const PATH = "/api/v1/ws";

function setWindow(host: string, protocol = "https:") {
  (globalThis as Record<string, unknown>).window = {
    location: { host, protocol },
  };
}

function clearWindow() {
  delete (globalThis as Record<string, unknown>).window;
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_WS_URL;
  delete process.env.NEXT_PUBLIC_API_BASE;
  clearWindow();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WS_URL;
  delete process.env.NEXT_PUBLIC_API_BASE;
  clearWindow();
});

describe("getWsUrl", () => {
  it("prefers the explicit NEXT_PUBLIC_WS_URL override (full URL)", () => {
    process.env.NEXT_PUBLIC_WS_URL = "wss://api.example.com/custom/ws";
    expect(getWsUrl(PATH)).toBe("wss://api.example.com/custom/ws");
  });

  it("derives wss from a https NEXT_PUBLIC_API_BASE (production)", () => {
    process.env.NEXT_PUBLIC_API_BASE = "https://api.example.com";
    expect(getWsUrl(PATH)).toBe("wss://api.example.com/api/v1/ws");
  });

  it("derives ws from a http NEXT_PUBLIC_API_BASE", () => {
    process.env.NEXT_PUBLIC_API_BASE = "http://api.example.com:3001";
    expect(getWsUrl(PATH)).toBe("ws://api.example.com:3001/api/v1/ws");
  });

  it("uses the same-origin host in the browser (preview, https)", () => {
    setWindow("3002-preview.monkeycode-ai.live", "https:");
    expect(getWsUrl(PATH)).toBe("wss://3002-preview.monkeycode-ai.live/api/v1/ws");
  });

  it("uses ws for a plain http browser origin", () => {
    setWindow("localhost:3002", "http:");
    expect(getWsUrl(PATH)).toBe("ws://localhost:3002/api/v1/ws");
  });

  it("falls back to the loopback API host server-side", () => {
    expect(getWsUrl(PATH)).toBe("ws://127.0.0.1:3001/api/v1/ws");
  });

  it("lets NEXT_PUBLIC_WS_URL win over NEXT_PUBLIC_API_BASE and window", () => {
    process.env.NEXT_PUBLIC_WS_URL = "ws://override.example.com/ws";
    process.env.NEXT_PUBLIC_API_BASE = "https://api.example.com";
    setWindow("preview.monkeycode-ai.live");
    expect(getWsUrl(PATH)).toBe("ws://override.example.com/ws");
  });
});
