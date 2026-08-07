import { describe, expect, it } from "vitest";
import { MemoryKillSwitchRepository } from "../repositories/killSwitchRepository";

describe("Kill Switch Persistence (A-03)", () => {
  it("survives repository re-initialization (memory clear)", async () => {
    const repo = new MemoryKillSwitchRepository();

    const all1 = await repo.getAll();
    expect(all1).toHaveLength(3);
    const cs = all1.find((s) => s.switch_name === "vendor_churn_protection");
    expect(cs?.is_triggered).toBe(false);

    await repo.upsert("vendor_churn_protection", {
      is_triggered: true,
      threshold_value: 10,
      current_value: 2.3,
    });

    const afterToggle = await repo.getByName("vendor_churn_protection");
    expect(afterToggle?.is_triggered).toBe(true);

    repo._reset();

    const afterReset = await repo.getAll();
    expect(afterReset).toHaveLength(3);
    const resetCs = afterReset.find((s) => s.switch_name === "vendor_churn_protection");
    expect(resetCs?.is_triggered).toBe(false);
    expect(resetCs?.threshold_value).toBe(10);
  });

  it("creates a new switch via upsert", async () => {
    const repo = new MemoryKillSwitchRepository();
    const created = await repo.upsert("rate_limit_protection", {
      is_triggered: true,
      threshold_value: 100,
      current_value: 50,
    });
    expect(created.switch_name).toBe("rate_limit_protection");
    expect(created.is_triggered).toBe(true);
    expect(created.threshold_value).toBe(100);

    const all = await repo.getAll();
    expect(all).toHaveLength(4);
  });

  it("getByName returns null for unknown switch", async () => {
    const repo = new MemoryKillSwitchRepository();
    const result = await repo.getByName("nonexistent");
    expect(result).toBeNull();
  });
});
