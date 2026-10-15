import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  clientIp,
  normalizeIp,
  parseTrustedProxies,
  trustProxyValue,
  type TrustedProxyConfig,
} from "./clientIp";

// Loopback in every form the socket peer may take (v4, v4-mapped v6, v6).
const LOOPBACK = ["127.0.0.1/32", "::ffff:127.0.0.1/128", "::1/128"];

function appWith(cfg: TrustedProxyConfig) {
  const app = express();
  app.set("trust proxy", trustProxyValue(cfg));
  app.get("/ip", (req, res) => {
    res.json({ ip: clientIp(req), raw: req.ip });
  });
  return app;
}

describe("normalizeIp / clientIp helper", () => {
  it("strips IPv4-mapped IPv6 consistently", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp(undefined)).toBeUndefined();
  });

  it("prefers req.ip and falls back to the socket peer, else unknown", () => {
    expect(clientIp({ ip: "::ffff:9.8.7.6" })).toBe("9.8.7.6");
    expect(clientIp({ socket: { remoteAddress: "::ffff:5.5.5.5" } })).toBe("5.5.5.5");
    expect(clientIp({})).toBe("unknown");
  });
});

describe("parseTrustedProxies", () => {
  it("treats undefined and blank as not-declared (trust nothing)", () => {
    for (const raw of [undefined, "", "   "]) {
      const cfg = parseTrustedProxies(raw);
      expect(cfg.declared).toBe(false);
      expect(cfg.disabled).toBe(true);
      expect(cfg.allowlist).toEqual([]);
      expect(cfg.error).toBeNull();
      expect(trustProxyValue(cfg)).toBe(false);
    }
  });

  it("accepts the literal 'none' as a declared, fail-safe choice", () => {
    const cfg = parseTrustedProxies("none");
    expect(cfg.declared).toBe(true);
    expect(cfg.disabled).toBe(true);
    expect(cfg.error).toBeNull();
    expect(trustProxyValue(cfg)).toBe(false);

    expect(parseTrustedProxies("NONE").disabled).toBe(true);
  });

  it("parses an explicit IP/CIDR allowlist", () => {
    const cfg = parseTrustedProxies("10.0.0.0/8, 192.168.0.1 ,2001:db8::/32");
    expect(cfg.declared).toBe(true);
    expect(cfg.disabled).toBe(false);
    expect(cfg.error).toBeNull();
    expect(cfg.allowlist).toEqual(["10.0.0.0/8", "192.168.0.1", "2001:db8::/32"]);
    expect(trustProxyValue(cfg)).toEqual(["10.0.0.0/8", "192.168.0.1", "2001:db8::/32"]);
  });

  it("rejects wildcards, malformed entries, bad prefixes and empties", () => {
    for (const bad of [
      "0.0.0.0/0",
      "::/0",
      "banana",
      "10.0.0.0/33",
      "10.0.0.0/",
      "10.0.0.0/8,,192.168.0.0/16",
    ]) {
      const cfg = parseTrustedProxies(bad);
      expect(cfg.error).not.toBeNull();
      expect(cfg.allowlist).toEqual([]);
      expect(trustProxyValue(cfg)).toBe(false);
    }
  });
});

describe("trust proxy behaviour (AUTH-G7)", () => {
  it("DIRECT_REQUEST_NO_XFF => socket peer", async () => {
    const res = await request(appWith(parseTrustedProxies("none"))).get("/ip").expect(200);
    expect(res.body.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect(res.body.ip).not.toBe("unknown");
  });

  it("DIRECT_REQUEST_SPOOFED_XFF => socket peer, spoof ignored", async () => {
    const app = appWith(parseTrustedProxies("none"));
    const base = await request(app).get("/ip").expect(200);
    const spoofed = await request(app)
      .get("/ip")
      .set("x-forwarded-for", "1.2.3.4")
      .expect(200);
    expect(spoofed.body.ip).toBe(base.body.ip);
    expect(spoofed.body.ip).not.toBe("1.2.3.4");
  });

  it("UNTRUSTED_PROXY_WITH_XFF => untrusted socket peer", async () => {
    const base = await request(appWith(parseTrustedProxies("none"))).get("/ip").expect(200);
    const res = await request(
      appWith(parseTrustedProxies("10.0.0.0/8")),
    )
      .get("/ip")
      .set("x-forwarded-for", "9.9.9.9")
      .expect(200);
    expect(res.body.ip).toBe(base.body.ip);
  });

  it("ONE_TRUSTED_PROXY => appended client address", async () => {
    const res = await request(appWith(parseTrustedProxies(LOOPBACK.join(","))))
      .get("/ip")
      .set("x-forwarded-for", "9.9.9.9")
      .expect(200);
    expect(res.body.ip).toBe("9.9.9.9");
  });

  it("ONE_TRUSTED_PROXY_WITH_CLIENT_INJECTED_LEFTMOST_XFF => real appended client", async () => {
    const res = await request(appWith(parseTrustedProxies(LOOPBACK.join(","))))
      .get("/ip")
      .set("x-forwarded-for", "6.6.6.6, 9.9.9.9")
      .expect(200);
    expect(res.body.ip).toBe("9.9.9.9");
  });

  it("MULTI_TRUSTED_PROXY_CHAIN => first untrusted/client hop", async () => {
    const trust = [...LOOPBACK, "10.0.0.5/32"].join(",");
    const res = await request(appWith(parseTrustedProxies(trust)))
      .get("/ip")
      .set("x-forwarded-for", "203.0.113.7, 10.0.0.5")
      .expect(200);
    expect(res.body.ip).toBe("203.0.113.7");
  });
});
