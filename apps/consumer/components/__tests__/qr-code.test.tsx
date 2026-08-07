import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QrCode } from "../QrCode";

describe("QrCode (I-02)", () => {
  it("renders a real QR SVG with the pickup label", () => {
    render(<QrCode orderId="order-1" otp="123456" size={180} />);
    expect(
      screen.getByRole("img", { name: "Pickup QR Code" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tap to enlarge")).toBeInTheDocument();
  });

  it("opens the fullscreen modal with OTP, Copy and Max Brightness controls", () => {
    render(<QrCode orderId="order-1" otp="987654" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Enlarge pickup QR code" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Pickup QR code" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("987654");
    expect(
      screen.getByRole("button", { name: "Copy OTP" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Max Brightness" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Pickup QR code large" }),
    ).toBeInTheDocument();
  });

  it("toggles Max Brightness to on", () => {
    render(<QrCode orderId="order-1" otp="111111" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Enlarge pickup QR code" }),
    );
    const toggle = screen.getByRole("button", { name: "Max Brightness" });
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: "Max Brightness On" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the modal", () => {
    render(<QrCode orderId="order-1" otp="222222" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Enlarge pickup QR code" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
