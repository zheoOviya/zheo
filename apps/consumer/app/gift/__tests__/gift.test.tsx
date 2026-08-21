import { describe, expect, it, vi, beforeEach } from "vitest";
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
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

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
  beforeEach(() => {
    // Mocks are module-level and the zustand store is a singleton: both carry
    // state across tests, so reset call history and start anonymous.
    vi.clearAllMocks();
    pushMock.mockClear();
    useAuthStore.setState({ accessToken: null, isAuthenticated: false, user: null });
  });
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

  it("redirects an unauthenticated user to login with a from backlink", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    // No valid refresh cookie: hydration fails fast and leaves the user
    // anonymous, so claiming must bounce to /login.
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      user: null,
      refreshAccessToken: vi.fn().mockRejectedValue(new Error("no session")),
    });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    const button = await screen.findByRole("button", { name: /Claim gift/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/login?from=/gift/tok1"),
    );
    expect(claimGift).not.toHaveBeenCalled();
  });

  it("lets a silently-hydrated session claim without a login redirect", async () => {
    // Returning user: refreshAccessToken sets only accessToken (never
    // isAuthenticated) on this public page. The claim gate keys on
    // accessToken so it must NOT bounce the user back to /login.
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    vi.mocked(claimGift).mockResolvedValue({ ...LANDING.gift, status: "CLAIMED" } as never);
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      user: null,
      refreshAccessToken: vi.fn().mockImplementation(async () => {
        useAuthStore.setState({ accessToken: "fresh-token" });
        return true;
      }),
    });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    const button = await screen.findByRole("button", { name: /Claim gift/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(claimGift).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining("/login?from="));
  });
});
