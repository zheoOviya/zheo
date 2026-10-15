import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_BINDING_SECRET_DEV_DEFAULT } from "./config";

const STRONG = "s".repeat(48);

type EnvPatch = Record<string, string | undefined>;

const saved: EnvPatch = {};

function applyEnv(patch: EnvPatch): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
}

async function loadEnv(): Promise<typeof import("./env")> {
  vi.resetModules();
  return import("./env");
}

describe("assertSecureConfig (production fail-closed)", () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it("is a no-op outside production even with no secrets", async () => {
    applyEnv({
      NODE_ENV: "test",
      JWT_SECRET: undefined,
      JWT_REFRESH_SECRET: undefined,
      DEVICE_BINDING_SECRET: undefined,
    });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).not.toThrow();
  });

  it("refuses to start in production without DEVICE_BINDING_SECRET", async () => {
    applyEnv({
      NODE_ENV: "production",
      JWT_SECRET: STRONG,
      JWT_REFRESH_SECRET: STRONG,
      DEVICE_BINDING_SECRET: undefined,
      ALLOW_DEV_AUTH_BYPASS: undefined,
      TRUSTED_PROXIES: "none",
    });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/DEVICE_BINDING_SECRET/);
  });

  it("refuses the dev-default DEVICE_BINDING_SECRET in production", async () => {
    applyEnv({
      NODE_ENV: "production",
      JWT_SECRET: STRONG,
      JWT_REFRESH_SECRET: STRONG,
      DEVICE_BINDING_SECRET: DEVICE_BINDING_SECRET_DEV_DEFAULT,
      ALLOW_DEV_AUTH_BYPASS: undefined,
      TRUSTED_PROXIES: "none",
    });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/DEVICE_BINDING_SECRET/);
  });

  it("accepts strong unique secrets in production", async () => {
    applyEnv({
      NODE_ENV: "production",
      JWT_SECRET: STRONG,
      JWT_REFRESH_SECRET: "r".repeat(48),
      DEVICE_BINDING_SECRET: "d".repeat(48),
      ALLOW_DEV_AUTH_BYPASS: undefined,
      TRUSTED_PROXIES: "none",
    });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).not.toThrow();
  });
});

describe("assertSecureConfig (TRUSTED_PROXIES fail-closed, AUTH-G7)", () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  const strongProd = (trusted: string | undefined): EnvPatch => ({
    NODE_ENV: "production",
    JWT_SECRET: STRONG,
    JWT_REFRESH_SECRET: "r".repeat(48),
    DEVICE_BINDING_SECRET: "d".repeat(48),
    ALLOW_DEV_AUTH_BYPASS: undefined,
    TRUSTED_PROXIES: trusted,
  });

  it("PROD_MISSING_TRUSTED_PROXIES => startup failure", async () => {
    applyEnv(strongProd(undefined));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });

  it("PROD_BLANK_TRUSTED_PROXIES => startup failure", async () => {
    applyEnv(strongProd("   "));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });

  it("PROD_NONE => valid, trust disabled", async () => {
    applyEnv(strongProd("none"));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).not.toThrow();
  });

  it("PROD_INVALID_CIDR => startup failure", async () => {
    applyEnv(strongProd("banana"));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });

  it("PROD_IPV4_WILDCARD => startup failure", async () => {
    applyEnv(strongProd("0.0.0.0/0"));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });

  it("PROD_IPV6_WILDCARD => startup failure", async () => {
    applyEnv(strongProd("::/0"));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });

  it("PROD_VALID_ALLOWLIST => valid", async () => {
    applyEnv(strongProd("10.0.0.0/8,192.168.0.0/16"));
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).not.toThrow();
  });

  it("NON_PROD_MISSING => valid (equivalent to none)", async () => {
    applyEnv({ NODE_ENV: "test", TRUSTED_PROXIES: undefined });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).not.toThrow();
  });

  it("NON_PROD_MALFORMED => still fails closed", async () => {
    applyEnv({ NODE_ENV: "test", TRUSTED_PROXIES: "not-an-ip" });
    const { assertSecureConfig } = await loadEnv();
    expect(() => assertSecureConfig()).toThrow(/TRUSTED_PROXIES/);
  });
});
