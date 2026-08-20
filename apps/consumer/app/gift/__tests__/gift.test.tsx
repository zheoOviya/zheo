import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GiftClaimPage from "../[token]/page";
import { fetchGiftLanding, claimGift } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchGiftLanding: vi.fn(), claimGift: vi.fn() };
});
vi.mock("@/components/BrandImage", () => ({
  BrandImage: () => <div data-testid="brand-image" />,
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const LANDING = {
  gift: {
    id: "g1",
    claim_token: "tok1",
    claim_code: "GIFT1234",
    item_snapshot: { name: "Paneer Wrap", price: 149, image_url: null, dietary_tags: {}, spice_level: 3, customizations: [] },
    message: "Enjoy!",
    status: "ACTIVE",
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  },
  restaurant: { name: "SnakShack", image_url: null },
  sender_display: "Ria",
  claimable: true,
};

describe("Gift claim page", () => {
  it("shows the gift card and a claim button when claimable", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true, user: { id: "u1", phone: "9999", role: "CONSUMER" } });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    expect(await screen.findByText("Paneer Wrap")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claim gift/ })).toBeTruthy();
  });

  it("disables claim and shows a reason for an expired gift", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue({
      ...LANDING,
      claimable: false,
      claim_block_reason: "This gift has expired",
      gift: { ...LANDING.gift, status: "EXPIRED" },
    } as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    expect(await screen.findByText("This gift has expired")).toBeTruthy();
    const button = screen.queryByRole("button", { name: /Claim gift/ });
    expect(button).toBeNull();
  });

  it("claims the gift and adds a free line to the cart", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    vi.mocked(claimGift).mockResolvedValue({ ...LANDING.gift, status: "CLAIMED" } as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true, user: { id: "u1", phone: "9999", role: "CONSUMER" } });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Claim gift/ }));
    await waitFor(() => expect(claimGift).toHaveBeenCalled());
  });
});
