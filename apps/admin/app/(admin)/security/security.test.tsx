// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecurityPage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  getTotpStatus: vi.fn(),
  enrollTotp: vi.fn(),
  confirmTotp: vi.fn(),
  disableTotp: vi.fn(),
  getAccessToken: vi.fn(),
  createQrMatrix: vi.fn(),
  qrSvgPath: vi.fn(),
  qrViewSize: vi.fn(),
}));

vi.mock("../../../lib/totp", () => mocks);
vi.mock("../../../lib/auth", () => mocks);
vi.mock("../../../lib/qr", () => mocks);

describe("Security page (2FA)", () => {
  beforeEach(() => {
    mocks.getAccessToken.mockReturnValue("token-1");
    mocks.getTotpStatus.mockResolvedValue({
      totp_enabled: false,
      enrolled: false,
      totp_confirmed_at: null,
    });
    mocks.createQrMatrix.mockReturnValue({ size: 21, dark: () => false });
    mocks.qrSvgPath.mockReturnValue("M0 0h5v5h-5z");
    mocks.qrViewSize.mockReturnValue(25);
  });

  it("shows the disabled state and guides to set up 2FA", async () => {
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByText(/Two-factor authentication is off/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /Set up 2FA/ })).toBeTruthy();
  });

  it("enrolls, renders the QR + secret, and confirms with a code", async () => {
    mocks.enrollTotp.mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_url: "otpauth://totp/SnakZap:x?secret=JBSWY3DPEHPK3PXP",
    });
    mocks.confirmTotp.mockResolvedValue({
      totp_enabled: true,
      totp_confirmed_at: "2026-08-13T00:00:00.000Z",
    });

    render(<SecurityPage />);
    await waitFor(() => screen.getByRole("button", { name: /Set up 2FA/ }));
    fireEvent.click(screen.getByRole("button", { name: /Set up 2FA/ }));

    await waitFor(() =>
      expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy(),
    );
    expect(screen.getByRole("img", { name: /2FA setup QR code/ })).toBeTruthy();

    const codeInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Enable/ }));

    await waitFor(() =>
      expect(screen.getByText(/Two-factor authentication is enabled/)).toBeTruthy(),
    );
    expect(mocks.confirmTotp).toHaveBeenCalledWith("token-1", "123456");
  });

  it("disables 2FA with a current code when already enabled", async () => {
    mocks.getTotpStatus.mockResolvedValue({
      totp_enabled: true,
      enrolled: true,
      totp_confirmed_at: "2026-08-13T00:00:00.000Z",
    });
    mocks.disableTotp.mockResolvedValue({ totp_enabled: false });

    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByText(/Two-factor authentication is enabled/)).toBeTruthy(),
    );

    const codeInput = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /Disable 2FA/ }));

    await waitFor(() =>
      expect(screen.getByText(/Two-factor authentication is off/)).toBeTruthy(),
    );
    expect(mocks.disableTotp).toHaveBeenCalledWith("token-1", "654321");
  });
});
