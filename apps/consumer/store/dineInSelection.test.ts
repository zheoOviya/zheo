import { describe, expect, it, beforeEach } from "vitest";
import { useDineInSelectionStore, DINE_IN_MAX_QUANTITY } from "./dineInSelection";

const ITEM = {
  menuItemId: "m-1",
  name: "Veg Bowl",
  displayPrice: 220,
};

describe("useDineInSelectionStore (UI3-B)", () => {
  beforeEach(() => {
    useDineInSelectionStore.getState().clear();
  });

  it("1. initial store is empty", () => {
    const s = useDineInSelectionStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.lines).toEqual([]);
    expect(s.itemCount()).toBe(0);
    expect(s.displayTotal()).toBe(0);
  });

  it("2. ensureScope adopts the session", () => {
    useDineInSelectionStore.getState().ensureScope("s1");
    expect(useDineInSelectionStore.getState().sessionId).toBe("s1");
  });

  it("3. a different session clears existing lines and adopts it", () => {
    const s = useDineInSelectionStore.getState();
    s.ensureScope("s1");
    s.add(ITEM);
    expect(s.itemCount()).toBe(1);

    s.ensureScope("s2");
    expect(useDineInSelectionStore.getState().sessionId).toBe("s2");
    expect(useDineInSelectionStore.getState().lines).toEqual([]);
  });

  it("4. first Add creates exactly one line at quantity 1", () => {
    useDineInSelectionStore.getState().add(ITEM);

    const lines = useDineInSelectionStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ menuItemId: "m-1", name: "Veg Bowl", displayPrice: 220, quantity: 1 });
  });

  it("5. repeated Add increments the same line", () => {
    const s = useDineInSelectionStore.getState();
    s.add(ITEM);
    s.add(ITEM);
    s.add(ITEM);

    expect(useDineInSelectionStore.getState().lines).toHaveLength(1);
    expect(useDineInSelectionStore.getState().lines[0]!.quantity).toBe(3);
  });

  it("6. no duplicate rows for the same menuItemId", () => {
    const s = useDineInSelectionStore.getState();
    s.add(ITEM);
    s.add({ ...ITEM, menuItemId: "m-2", name: "Paneer Roll", displayPrice: 180 });
    s.add(ITEM);

    expect(useDineInSelectionStore.getState().lines).toHaveLength(2);
    expect(useDineInSelectionStore.getState().itemCount()).toBe(3);
  });

  it("7. setQuantity decrements a line", () => {
    const s = useDineInSelectionStore.getState();
    s.add(ITEM);
    s.add(ITEM);
    s.setQuantity("m-1", 1);

    expect(useDineInSelectionStore.getState().lines[0]!.quantity).toBe(1);
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
  });

  it("8. decrement to zero removes the line", () => {
    const s = useDineInSelectionStore.getState();
    s.add(ITEM);
    s.setQuantity("m-1", 0);

    expect(useDineInSelectionStore.getState().lines).toEqual([]);
  });

  it("9. max quantity 50 is enforced (add is a no-op at the cap)", () => {
    const s = useDineInSelectionStore.getState();
    for (let i = 0; i < 50; i++) s.add(ITEM);
    expect(useDineInSelectionStore.getState().lines[0]!.quantity).toBe(
      DINE_IN_MAX_QUANTITY,
    );

    s.add(ITEM);
    s.setQuantity("m-1", 999);
    expect(useDineInSelectionStore.getState().lines[0]!.quantity).toBe(
      DINE_IN_MAX_QUANTITY,
    );
    expect(useDineInSelectionStore.getState().itemCount()).toBe(
      DINE_IN_MAX_QUANTITY,
    );
  });

  it("15. selection never stores token/customizations/extra fields", () => {
    const s = useDineInSelectionStore.getState();
    s.ensureScope("s1");
    // Runtime smuggling attempt through the public API shape.
    (
      s.add as unknown as (item: Record<string, unknown>) => void
    )({
      menuItemId: "m-1",
      name: "Veg Bowl",
      displayPrice: 220,
      customizations: [{ name: "Cheese", price_delta: 30 }],
      tableToken: "super-secret",
    });

    const lines = useDineInSelectionStore.getState().lines;
    expect(Object.keys(lines[0]!).sort()).toEqual([
      "displayPrice",
      "menuItemId",
      "name",
      "quantity",
    ]);
    const json = JSON.stringify(lines);
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("Cheese");
    expect(json).not.toContain("customizations");
  });
});
