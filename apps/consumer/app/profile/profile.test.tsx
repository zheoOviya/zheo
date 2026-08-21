import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ProfilePage from "./page";
import { ThemeProvider } from "@/components/ThemeProvider";
import { useAuthStore } from "@/lib/store";
import {
  fetchWallet,
  fetchStreak,
  fetchVipStatus,
  fetchReferralProfile,
  fetchStampCards,
  fetchRestaurants,
  type WalletData,
  type StreakData,
  type VipStatus,
  type ReferralProfile,
  type StampCard,
  type Restaurant,
} from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchWallet: vi.fn(),
    fetchStreak: vi.fn(),
    fetchVipStatus: vi.fn(),
    fetchReferralProfile: vi.fn(),
    fetchStampCards: vi.fn(),
    fetchRestaurants: vi.fn(),
    updateSpiceTolerance: vi.fn(),
    applyReferral: vi.fn(),
    createSupportTicket: vi.fn(),
    fetchMyGifts: vi.fn(),
    cancelGift: vi.fn(),
    retryGiftPayment: vi.fn(),
  };
});

const wallet: WalletData = {
  user_id: "u1",
  balance: 42,
  total_earned: 50,
  transactions: [],
};

const streak: StreakData = {
  current_streak: 2,
  best_streak: 9,
  last_pickup_day: null,
  days_to_next_badge: 5,
};

const vip: VipStatus = {
  is_vip: false,
  order_count: 1,
  total_spend: 100,
  order_threshold: 20,
  spend_threshold: 5000,
};

const referral: ReferralProfile = {
  referral_code: "SNKZ-ABC123",
  bonus_amount: 50,
  balance: 42,
  total_earned: 50,
};

const noCards: StampCard[] = [];
const noRestaurants: Restaurant[] = [];

describe("ProfilePage", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "tok-123",
      user: { id: "u1", phone: "9876543210", role: "CONSUMER" },
      isAuthenticated: true,
    });
    vi.mocked(fetchWallet).mockResolvedValue(wallet);
    vi.mocked(fetchStreak).mockResolvedValue(streak);
    vi.mocked(fetchVipStatus).mockResolvedValue(vip);
    vi.mocked(fetchReferralProfile).mockResolvedValue(referral);
    vi.mocked(fetchStampCards).mockResolvedValue(noCards);
    vi.mocked(fetchRestaurants).mockResolvedValue(noRestaurants);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders every account section independently when one endpoint fails", async () => {
    vi.mocked(fetchVipStatus).mockRejectedValue(new Error("vip service down"));

    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(await screen.findByText("Wallet & Rewards")).toBeDefined();
    expect(screen.getByText("Refer & Earn")).toBeDefined();
    expect(screen.getByText("Stamp Cards")).toBeDefined();
    expect(screen.getByText("Spice Profile")).toBeDefined();

    // The failing VIP section must not blank the rest of the page.
    expect(screen.queryByText("VIP Customer Support")).toBeNull();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/);
  });

  it("renders the global header with the account menu", async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(screen.getByRole("link", { name: "SnakZap home" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
  });

  it("marks the spice profile as optional with clear copy", async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(await screen.findByText("Spice Profile")).toBeDefined();
    expect(screen.getByText("Optional")).toBeDefined();
    expect(screen.getByText(/Leave it unset to browse the full menu/)).toBeDefined();
  });

  it("reassures users that standard support stays available without VIP", async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(await screen.findByText("VIP Customer Support")).toBeDefined();
    expect(screen.getByText(/Standard support is always available/)).toBeDefined();
  });

  it("renders skeleton loaders with aria-busy while sections load", async () => {
    vi.mocked(fetchWallet).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchStreak).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchVipStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchReferralProfile).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchStampCards).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchRestaurants).mockReturnValue(new Promise(() => {}));

    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    const skeletons = await screen.findAllByRole("status");
    expect(skeletons.length).toBeGreaterThan(0);
    for (const skeleton of skeletons) {
      expect(skeleton.getAttribute("aria-busy")).toBe("true");
    }
  });

  it("exposes screen-reader labels for icon-only controls", async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Spice level 1: Mild" })).toBeDefined();
  });
});
