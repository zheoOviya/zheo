import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import GiftSuccess from "../GiftSuccess";
import type { Gift } from "@/lib/api";

const GIFT: Gift = {
  id: "g1",
  sender_id: "s1",
  restaurant_id: "r1",
  menu_item_id: "m1",
  item_snapshot: { name: "Paneer Wrap", price: 149, image_url: null, dietary_tags: {}, spice_level: 3, customizations: [] },
  price_paid: 149,
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
  expires_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as Gift;

describe("GiftSuccess", () => {
  it("renders the shareable link and code", () => {
    render(<GiftSuccess gift={GIFT} />);
    expect(screen.getByText("GIFT1234")).toBeTruthy();
    expect(screen.getByText(/gift\/tok1/)).toBeTruthy();
  });
});
