import { describe, it, expect } from "vitest";

describe("I18nProvider", () => {
  it("exports I18nProvider and useI18n", async () => {
    const mod = await import("../lib/i18n");
    expect(mod.I18nProvider).toBeDefined();
    expect(mod.useI18n).toBeDefined();
  });
});
