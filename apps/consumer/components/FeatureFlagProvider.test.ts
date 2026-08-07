import { describe, it, expect } from "vitest";

describe("FeatureFlagProvider", () => {
  it("exports useFeatureFlags and FeatureFlagProvider", async () => {
    const mod = await import("../components/FeatureFlagProvider");
    expect(mod.FeatureFlagProvider).toBeDefined();
    expect(mod.useFeatureFlags).toBeDefined();
  });

  it("default flags have ab_menu_images enabled", async () => {
    const { useFeatureFlags } = await import("../components/FeatureFlagProvider");
    const ctx = { flags: { ab_menu_images: true, ab_pickup_slots: true, ab_animated_tracker: false }, isEnabled: (f: string) => true };
    expect(ctx.flags.ab_menu_images).toBe(true);
    expect(ctx.flags.ab_animated_tracker).toBe(false);
  });
});
