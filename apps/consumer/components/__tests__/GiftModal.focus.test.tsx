import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GiftModal from "../GiftModal";
import { CustomizationPicker } from "../CustomizationPicker";
import GiftSuccess from "../GiftSuccess";
import { createGift, simulatePaymentWebhook } from "@/lib/api";
import { useAuthStore, type CartCustomization } from "@/lib/store";
import type { Gift, MenuItem } from "@/lib/api";

// Focus-ownership contract for the GiftModal shell, delegated to the shared
// `useDialogFocus` hook. Payment core is frozen and never exercised for real.
const rzp = vi.hoisted(() => ({
  config: null as null | { handler: () => void | Promise<void> },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createGift: vi.fn(),
    retryGiftPayment: vi.fn(),
    simulatePaymentWebhook: vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/razorpay", () => ({
  loadRazorpayScript: vi.fn().mockResolvedValue(true),
  createRazorpayInstance: vi.fn((config: { handler: () => void | Promise<void> }) => {
    rzp.config = config;
    return { open: vi.fn(() => void config.handler()) };
  }),
}));

const ITEM: MenuItem = {
  id: "m1",
  restaurant_id: "r1",
  name: "Paneer Wrap",
  price: 149,
  image_url: null,
  dietary_tags: { VEG: true },
  spice_level: 3,
  customizations: [{ name: "Extra Cheese", price_delta: 30 }],
  is_available: true,
} as MenuItem;

const CUSTOMS: CartCustomization[] = [{ name: "Extra Cheese", price_delta: 30 }];

const GIFT: Gift = {
  id: "g1",
  sender_id: "s1",
  restaurant_id: "r1",
  menu_item_id: "m1",
  item_snapshot: {
    name: "Paneer Wrap",
    price: 149,
    image_url: null,
    dietary_tags: {},
    spice_level: 3,
    customizations: [],
  },
  price_paid: 179,
  message: null,
  recipient_name: null,
  claim_token: "tok1",
  claim_code: "GIFT1234",
  status: "ACTIVE",
  payment_id: null,
  claimed_by: null,
  claimed_at: null,
  fulfilled_at: null,
  refunded_at: null,
  expires_at: "2030-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Gift;

const CREATE_RESULT = {
  gift: GIFT,
  razorpay_order_id: "order_x",
  amount: 179,
  currency: "INR",
};

function giftDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Gift this item" });
}

function renderGiftModal(onClose: () => void = vi.fn()) {
  return render(
    <GiftModal
      restaurantId="r1"
      item={ITEM}
      customizations={CUSTOMS}
      onPaid={() => {}}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  rzp.config = null;
  useAuthStore.setState({ accessToken: "t", isAuthenticated: true });
  vi.mocked(createGift).mockReset();
  vi.mocked(createGift).mockResolvedValue(CREATE_RESULT);
  vi.mocked(simulatePaymentWebhook).mockReset();
  vi.mocked(simulatePaymentWebhook).mockResolvedValue({ orderStatus: "ACTIVE" });
});

describe("GiftModal focus ownership", () => {
  it("1. moves focus inside the GiftModal shell when opened", async () => {
    renderGiftModal();
    const dialog = giftDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("2. wraps Tab from the last control back to the first", () => {
    renderGiftModal();
    const pay = screen.getByRole("button", { name: /Pay & Send/ });
    const close = screen.getByRole("button", { name: "Close" });

    pay.focus();
    expect(pay).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("3. wraps Shift+Tab from the first control to the last", () => {
    renderGiftModal();
    const close = screen.getByRole("button", { name: "Close" });
    const pay = screen.getByRole("button", { name: /Pay & Send/ });

    close.focus();
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(pay).toHaveFocus();
  });

  it("4. closes on Escape when not paying", () => {
    const onClose = vi.fn();
    renderGiftModal(onClose);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("5. ignores Escape while a payment is in flight", async () => {
    vi.mocked(createGift).mockImplementationOnce(() => new Promise<never>(() => {}));
    const onClose = vi.fn();
    renderGiftModal(onClose);

    fireEvent.click(screen.getByRole("button", { name: /Pay & Send/ }));
    await waitFor(() => expect(createGift).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("6. settles focus inside GiftModal after the Picker -> GiftModal handoff", async () => {
    function HandoffHarness() {
      const [showPicker, setShowPicker] = useState(false);
      const [payload, setPayload] = useState<CartCustomization[] | null>(null);
      return (
        <>
          <button type="button" onClick={() => setShowPicker(true)}>
            Gift Paneer Wrap
          </button>
          {showPicker && (
            <CustomizationPicker
              itemName="Paneer Wrap"
              basePrice={149}
              availableCustomizations={CUSTOMS}
              onConfirm={(selected) => {
                setPayload(selected);
                setShowPicker(false);
              }}
              onCancel={() => setShowPicker(false)}
            />
          )}
          {payload && (
            <GiftModal
              restaurantId="r1"
              item={ITEM}
              customizations={payload}
              onPaid={() => {}}
              onClose={() => setPayload(null)}
            />
          )}
        </>
      );
    }

    render(<HandoffHarness />);
    const trigger = screen.getByRole("button", { name: "Gift Paneer Wrap" });
    trigger.focus();
    fireEvent.click(trigger);

    const picker = await screen.findByRole("dialog", { name: /Customize Paneer Wrap/ });
    await waitFor(() => expect(picker.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Add to Cart/ }));

    const dialog = await screen.findByRole("dialog", { name: "Gift this item" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(trigger).not.toHaveFocus();
  });

  async function completeSuccessFlow() {
    const onClose = vi.fn();
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <button type="button">background gift trigger</button>
          {show && (
            <GiftModal
              restaurantId="r1"
              item={ITEM}
              customizations={CUSTOMS}
              onPaid={() => {}}
              onClose={onClose}
            />
          )}
        </>
      );
    }

    const { rerender } = render(<Harness show={false} />);
    const trigger = screen.getByRole("button", { name: "background gift trigger" });
    trigger.focus();
    rerender(<Harness show={true} />);

    await waitFor(() => expect(giftDialog().contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Pay & Send/ }));
    const successDialog = await screen.findByRole("dialog", { name: "Gift sent" });
    await waitFor(() => expect(successDialog.contains(document.activeElement)).toBe(true));

    return { onClose, trigger, successDialog };
  }

  it("7. renders GiftSuccess after a mocked payment success", async () => {
    await completeSuccessFlow();

    expect(screen.getByRole("dialog", { name: "Gift sent" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Gift this item" })).not.toBeInTheDocument();
  });

  it("8. settles final focus inside GiftSuccess and keeps exactly one dialog + scroll lock", async () => {
    const { successDialog } = await completeSuccessFlow();

    expect(successDialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Gift sent");
  });

  it("9. does not leave the background gift trigger as the final active element", async () => {
    const { trigger } = await completeSuccessFlow();

    expect(trigger).not.toHaveFocus();
  });

  it("10. has no stale GiftModal keydown owner after success", async () => {
    const { onClose } = await completeSuccessFlow();

    fireEvent.keyDown(document, { key: "Escape" });

    // Exactly one owner remains (GiftSuccess); a surviving GiftModal listener
    // would have fired a second time.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("11. GiftSuccess closes on Escape only when onClose exists", () => {
    const onClose = vi.fn();
    const { unmount } = render(<GiftSuccess gift={GIFT} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(<GiftSuccess gift={GIFT} />);
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("12. closing GiftSuccess restores the original Gift trigger", async () => {
    function CloseHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            background gift trigger
          </button>
          {open && (
            <GiftModal
              restaurantId="r1"
              item={ITEM}
              customizations={CUSTOMS}
              onPaid={() => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<CloseHarness />);
    const trigger = screen.getByRole("button", { name: "background gift trigger" });
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() => expect(giftDialog().contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Pay & Send/ }));
    const successDialog = await screen.findByRole("dialog", { name: "Gift sent" });
    await waitFor(() => expect(successDialog.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });
});
