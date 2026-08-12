import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginPage from "./page";
import { useAuthStore } from "@/lib/store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function typePhone() {
  fireEvent.change(screen.getByLabelText("Phone Number"), {
    target: { value: "9876543210" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
}

describe("LoginPage on-screen demo OTP", () => {
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

  it("shows the demo code on-screen and prefills the OTP inputs", async () => {
    render(<LoginPage />);
    typePhone();

    await waitFor(() => {
      expect(screen.getByTestId("demo-otp")).toBeTruthy();
    });

    expect(screen.getByText("123456")).toBeTruthy();

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs).toHaveLength(6);
    expect(inputs.map((i) => i.value).join("")).toBe("123456");

    const verifyBtn = screen.getByRole("button", { name: "Verify & Sign In" });
    expect(verifyBtn.hasAttribute("disabled")).toBe(false);
  });

  it("falls back to manual entry when the API returns no demo code", async () => {
    useAuthStore.setState({
      sendOtp: vi.fn().mockResolvedValue({ sent: true, expiresIn: 300 }),
    });

    render(<LoginPage />);
    typePhone();

    await waitFor(() => {
      expect(screen.getByText(/No SMS is sent in this preview/)).toBeTruthy();
    });

    expect(screen.queryByTestId("demo-otp")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Verify & Sign In" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
