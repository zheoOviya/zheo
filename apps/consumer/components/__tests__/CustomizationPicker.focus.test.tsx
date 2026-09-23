import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CustomizationPicker } from "../CustomizationPicker";
import type { CartCustomization } from "@/lib/store";

// Focus-ownership contract for the Customization Picker, delegated to the
// shared `useDialogFocus` hook (same primitive the Dine-In dialogs use).
const CUSTOMS: CartCustomization[] = [
  { name: "Extra Cheese", price_delta: 30 },
  { name: "Extra Veggies", price_delta: 20 },
];

function renderPicker(overrides: {
  onConfirm?: (selected: CartCustomization[]) => void;
  onCancel?: () => void;
  pending?: boolean;
  success?: boolean;
} = {}) {
  return render(
    <CustomizationPicker
      itemName="Paneer Wrap"
      basePrice={149}
      availableCustomizations={CUSTOMS}
      onConfirm={overrides.onConfirm ?? vi.fn()}
      onCancel={overrides.onCancel ?? vi.fn()}
      pending={overrides.pending}
      success={overrides.success}
    />,
  );
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: /Customize Paneer Wrap/ });
}

describe("CustomizationPicker focus ownership", () => {
  it("1. moves focus inside the dialog when it opens", async () => {
    renderPicker();
    await waitFor(() => expect(dialog().contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("button", { name: /Extra Cheese/ })).toHaveFocus();
  });

  it("2. wraps Tab from the last control back to the first", async () => {
    renderPicker();
    const confirm = screen.getByRole("button", { name: /Add to Cart/ });
    const first = screen.getByRole("button", { name: /Extra Cheese/ });

    confirm.focus();
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("3. wraps Shift+Tab from the first control to the last", async () => {
    renderPicker();
    const first = screen.getByRole("button", { name: /Extra Cheese/ });
    const confirm = screen.getByRole("button", { name: /Add to Cart/ });

    first.focus();
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("4. closes on Escape when unlocked", () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("5. ignores Escape while pending", () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel, pending: true });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("6. keeps focus on the dialog container when every control is disabled", async () => {
    renderPicker({ pending: true });
    const container = dialog();

    await waitFor(() => expect(container).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab" });
    expect(container).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(container).toHaveFocus();
  });

  it("7. Cancel and backdrop invoke onCancel without focus escaping before unmount", async () => {
    const onCancel = vi.fn();
    renderPicker({ onCancel });
    const container = dialog();

    await waitFor(() => expect(container.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.contains(document.activeElement)).toBe(true);

    const backdrop = container.parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("8. restores focus to the opener when the picker unmounts", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open picker
          </button>
          {open && (
            <CustomizationPicker
              itemName="Paneer Wrap"
              basePrice={149}
              availableCustomizations={CUSTOMS}
              onConfirm={vi.fn()}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open picker" });
    opener.focus();
    fireEvent.click(opener);

    const container = await screen.findByRole("dialog", { name: /Customize Paneer Wrap/ });
    await waitFor(() => expect(container.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("9. owns the body scroll lock for the lifetime of the dialog", () => {
    const { unmount } = renderPicker();
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
