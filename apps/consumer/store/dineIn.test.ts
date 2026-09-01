import { describe, expect, it, beforeEach } from "vitest";
import { useDineInStore } from "./dineIn";

const CONTEXT = {
  sessionId: "s1",
  restaurant: { id: "r1", name: "SnakShack" },
  table: { id: "t1", label: "Table 12" },
  sessionStatus: "OPEN" as const,
};

describe("useDineInStore (UI1-B4)", () => {
  beforeEach(() => {
    useDineInStore.getState().clearContext();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("1. initial store is empty", () => {
    expect(useDineInStore.getState().context).toBeNull();
  });

  it("2. setContext stores exactly the allowed fields", () => {
    useDineInStore.getState().setContext(CONTEXT);

    const ctx = useDineInStore.getState().context;
    expect(ctx).toEqual(CONTEXT);
    expect(ctx && Object.keys(ctx).sort()).toEqual([
      "restaurant",
      "sessionId",
      "sessionStatus",
      "table",
    ]);
    expect(ctx && Object.keys(ctx.restaurant).sort()).toEqual(["id", "name"]);
    expect(ctx && Object.keys(ctx.table).sort()).toEqual(["id", "label"]);
  });

  it("3. clearContext empties the store", () => {
    useDineInStore.getState().setContext(CONTEXT);
    useDineInStore.getState().clearContext();

    expect(useDineInStore.getState().context).toBeNull();
  });

  it("4. the opaque token cannot enter the store through the public API", () => {
    // The public setContext signature has no token field. Even if a caller
    // smuggles one at runtime, the stored shape excludes it.
    const withToken = { ...CONTEXT, tableToken: "super-secret" };
    (
      useDineInStore.getState().setContext as unknown as (
        ctx: typeof withToken,
      ) => void
    )(withToken);

    const ctx = useDineInStore.getState().context;
    expect(ctx && Object.keys(ctx).sort()).toEqual([
      "restaurant",
      "sessionId",
      "sessionStatus",
      "table",
    ]);
    expect(ctx).not.toHaveProperty("tableToken");
    expect(JSON.stringify(ctx)).not.toContain("super-secret");
  });

  it("5. no localStorage/sessionStorage writes", () => {
    useDineInStore.getState().setContext(CONTEXT);

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
