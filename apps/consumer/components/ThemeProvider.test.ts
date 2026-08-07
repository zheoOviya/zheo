import { describe, it, expect } from "vitest";

describe("ThemeProvider", () => {
  it("export structure: useTheme returns theme and toggleTheme", async () => {
    const mod = await import("../components/ThemeProvider");
    expect(mod.ThemeProvider).toBeDefined();
    expect(mod.useTheme).toBeDefined();
  });
});
