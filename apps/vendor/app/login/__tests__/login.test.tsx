import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import VendorLoginPage from "../page";

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    replace: vi.fn(),
    isAuthenticated: vi.fn(),
    storeSession: vi.fn(),
    getDeviceFingerprint: vi.fn(() => "vendor-test-fp-0001"),
    vendorSendOtp: vi.fn(),
    vendorSignup: vi.fn(),
    vendorVerifyOtp: vi.fn(),
    ApiError,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
  storeSession: mocks.storeSession,
  getDeviceFingerprint: mocks.getDeviceFingerprint,
}));

vi.mock("@/lib/api", () => ({
  ApiError: mocks.ApiError,
  vendorSendOtp: mocks.vendorSendOtp,
  vendorSignup: mocks.vendorSignup,
  vendorVerifyOtp: mocks.vendorVerifyOtp,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.isAuthenticated.mockReturnValue(false);
  mocks.vendorSendOtp.mockResolvedValue("123456");
});

describe("Vendor /login page (phone + OTP)", () => {
  it("renders the phone step with a send-OTP call to action", () => {
    render(<VendorLoginPage />);
    expect(screen.getByText("SnakZap Merchant")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send OTP" })).toBeDefined();
    expect(screen.getByPlaceholderText("+91XXXXXXXXXX")).toBeDefined();
  });

  it("redirects to the dashboard when already authenticated", () => {
    mocks.isAuthenticated.mockReturnValue(true);
    render(<VendorLoginPage />);
    expect(mocks.replace).toHaveBeenCalledWith("/");
  });

  it("signs up a new merchant when the phone has no vendor account yet", async () => {
    mocks.vendorSendOtp
      .mockRejectedValueOnce(new mocks.ApiError("No vendor account", "VENDOR_NOT_FOUND", 404))
      .mockResolvedValueOnce("654321");
    mocks.vendorSignup.mockResolvedValue({ id: "u1", phone: "+919876543210", role: "PENDING_VENDOR" });

    render(<VendorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText("+91XXXXXXXXXX"), {
      target: { value: "+919876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));

    await waitFor(() => {
      expect(mocks.vendorSignup).toHaveBeenCalledWith("+919876543210");
      expect(mocks.vendorSendOtp).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/New merchant account created/)).toBeDefined();
    expect(screen.getByText("Demo code: 654321")).toBeDefined();
  });

  it("verifies the OTP, stores the session and redirects to the dashboard", async () => {
    mocks.vendorVerifyOtp.mockResolvedValue({
      access_token: "access-123",
      user: { id: "u1", phone: "+919876543210", role: "VENDOR_OWNER" },
    });

    render(<VendorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText("+91XXXXXXXXXX"), {
      target: { value: "+919876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));

    await waitFor(() => expect(screen.getByPlaceholderText("000000")).toBeDefined());
    fireEvent.change(screen.getByPlaceholderText("000000"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & sign in" }));

    await waitFor(() => {
      expect(mocks.vendorVerifyOtp).toHaveBeenCalledWith(
        "+919876543210",
        "123456",
        "vendor-test-fp-0001",
      );
      expect(mocks.storeSession).toHaveBeenCalledWith("access-123", {
        id: "u1",
        phone: "+919876543210",
        role: "VENDOR_OWNER",
      });
      expect(mocks.replace).toHaveBeenCalledWith("/");
    });
  });

  it("redirects a PENDING_VENDOR to the onboarding status page", async () => {
    mocks.vendorVerifyOtp.mockResolvedValue({
      access_token: "access-123",
      user: { id: "u1", phone: "+919876543210", role: "PENDING_VENDOR" },
    });

    render(<VendorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText("+91XXXXXXXXXX"), {
      target: { value: "+919876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));

    await waitFor(() => expect(screen.getByPlaceholderText("000000")).toBeDefined());
    fireEvent.change(screen.getByPlaceholderText("000000"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & sign in" }));

    await waitFor(() => {
      expect(mocks.storeSession).toHaveBeenCalledWith("access-123", {
        id: "u1",
        phone: "+919876543210",
        role: "PENDING_VENDOR",
      });
      expect(mocks.replace).toHaveBeenCalledWith("/apply/status");
    });
  });

  it("surfaces a verification error without storing a session", async () => {
    mocks.vendorVerifyOtp.mockRejectedValue(new mocks.ApiError("Invalid OTP", "OTP_INVALID", 400));

    render(<VendorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText("+91XXXXXXXXXX"), {
      target: { value: "+919876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
    await waitFor(() => expect(screen.getByPlaceholderText("000000")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText("000000"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & sign in" }));

    await waitFor(() => expect(screen.getByText("Invalid OTP")).toBeDefined());
    expect(mocks.storeSession).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
