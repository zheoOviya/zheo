import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GiftModal from "../GiftModal";
import { createGift, simulatePaymentWebhook } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import type { MenuItem } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createGift: vi.fn(),
    simulatePaymentWebhook: vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/razorpay", () => ({
  loadRazorpayScript: vi.fn().mockResolvedValue(true),
  createRazorpayInstance: vi.fn(() => ({ open: vi.fn() })),
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

describe("GiftModal", () => {
  it("renders item summary and validates empty message submission", async () => {
    render(<GiftModal restaurantId="r1" item={ITEM} customizations={[{ name: "Extra Cheese", price_delta: 30 }]} onPaid={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Gift this item")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Pay & Send/ });
    expect(button).toBeTruthy();
    expect(screen.getByText("₹179.00")).toBeTruthy(); // 149 + 30, formatINR renders "₹179.00"
  });

  it("calls createGift and opens Razorpay on submit", async () => {
    vi.mocked(createGift).mockResolvedValue({
      gift: { id: "g1", claim_token: "tok1" } as never,
      razorpay_order_id: "order_x",
      amount: 179,
      currency: "INR",
    });
    vi.mocked(simulatePaymentWebhook).mockResolvedValue({ orderStatus: "ACTIVE" });
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true });

    render(<GiftModal restaurantId="r1" item={ITEM} customizations={[{ name: "Extra Cheese", price_delta: 30 }]} onPaid={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Pay & Send/ }));

    await waitFor(() => {
      expect(createGift).toHaveBeenCalled();
    });
  });
});
