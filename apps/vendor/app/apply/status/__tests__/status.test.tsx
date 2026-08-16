import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import VendorOnboardingStatusPage from "../page";

type SessionUser = { id: string; phone: string; role: string };

interface Application {
  id: string;
  applicant_id: string;
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  type: "SINGLE" | "CHAIN";
  outlet_count: number;
  rejection_reason: string | null;
  created_at: string;
}

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  getSessionUser: vi.fn<() => SessionUser | null>(() => ({
    id: "u1",
    phone: "+919876543210",
    role: "PENDING_VENDOR",
  })),
  logout: vi.fn(() => Promise.resolve()),
  fetchMyApplications: vi.fn<() => Promise<Application[]>>(() => Promise.resolve([])),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
  logout: mocks.logout,
}));

vi.mock("@/lib/api", () => ({
  fetchMyApplications: mocks.fetchMyApplications,
}));

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: "a1",
    applicant_id: "u1",
    name: "Spice Route",
    gst_number: "27ABCDE1234F1Z5",
    fssai_license: "11522000000000",
    phone: "+919876543210",
    status: "PENDING",
    type: "SINGLE",
    outlet_count: 1,
    rejection_reason: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getSessionUser.mockReturnValue({
    id: "u1",
    phone: "+919876543210",
    role: "PENDING_VENDOR",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Vendor onboarding status page", () => {
  it("shows pending review for a PENDING application", async () => {
    mocks.fetchMyApplications.mockResolvedValue([application({ status: "PENDING" })]);

    render(<VendorOnboardingStatusPage />);

    await waitFor(() => {
      expect(screen.getByText("Application under review")).toBeDefined();
    });
    expect(screen.getByText("Spice Route")).toBeDefined();
  });

  it("prompts to apply when no application exists", async () => {
    mocks.fetchMyApplications.mockResolvedValue([]);

    render(<VendorOnboardingStatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/You have not submitted an application yet/)).toBeDefined();
    });
    expect(screen.getByRole("link", { name: "Apply to onboard your restaurant" })).toBeDefined();
  });

  it("redirects to /login when there is no session", async () => {
    mocks.getSessionUser.mockReturnValue(null);

    render(<VendorOnboardingStatusPage />);

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/login");
    });
  });
});
