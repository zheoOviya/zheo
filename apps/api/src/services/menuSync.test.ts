import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// POS-MOCK-PROD-ISOLATION (unit)
//
// Proves the POS menu-sync composition never wires the mock client in
// production, while dev/test keep it. The route-level fail-closed behaviour
// is proven in routes/vendorOps.posGate.test.ts.
// ============================================

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

async function loadMenuSync(env: EnvPatch) {
  applyEnv(env);
  vi.resetModules();
  return import("./menuSync");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("POS menu client selection (POS-MOCK-PROD-ISOLATION)", () => {
  it("production wires NO service: the mock client is never constructed", async () => {
    const { createMenuSyncService } = await loadMenuSync({
      NODE_ENV: "production",
    });
    expect(createMenuSyncService({} as never)).toBeNull();
  });

  it("test wires a mock-backed MenuSyncService", async () => {
    const mod = await loadMenuSync({ NODE_ENV: "test" });
    const service = mod.createMenuSyncService({} as never);
    expect(service).toBeInstanceOf(mod.MenuSyncService);
  });

  it("development wires a mock-backed MenuSyncService", async () => {
    const mod = await loadMenuSync({ NODE_ENV: "development" });
    const service = mod.createMenuSyncService({} as never);
    expect(service).toBeInstanceOf(mod.MenuSyncService);
  });

  it("non-production mock returns the canned POS menu", async () => {
    const mod = await loadMenuSync({ NODE_ENV: "test" });
    const menu = await new mod.MockPosMenuClient().getMenu(
      "a0000000-0000-4000-8000-000000000001",
    );
    expect(menu).toHaveLength(4);
    expect(menu.map((item) => item.pos_item_id)).toContain("pp-3001");
  });
});
