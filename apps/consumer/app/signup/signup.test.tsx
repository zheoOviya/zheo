import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SignupPage from "./page";
import { useAuthStore } from "@/lib/store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

describe("SignupPage", () => {
  beforeEach(() => {
    useAuthStore.setState({
      sendOtp: vi.fn().mockResolvedValue({
        sent: true,
        expiresIn: 300,
        demoOtp: "123456",
      }),
      login: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("shows the create-account copy and CTA", async () => {
    render(<SignupPage />);

    expect(screen.getByText("Enter your phone number to create your account")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Phone Number"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create Account" })).toBeDefined();
    });
  });
});
