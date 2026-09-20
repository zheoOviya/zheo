import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OtpInput } from "../OtpInput";

// ============================================
// CONSUMER_UI-A2a — OTP accessibility foundation.
//
// Locks the frozen contracts CA-1..CA-3:
//   CA-1 the digit group exposes the visible label "Enter OTP"
//   CA-2 every digit input has a deterministic accessible name and the
//        error message is role=alert + associated with the digits
//   CA-3 the existing interaction model (typing advances focus, Backspace
//        clears/moves, paste populates) is unchanged
//
// Source-contract only: no git history, no checkout depth, no working-tree.
// ============================================

function Harness({ error }: { error?: string }) {
  const [value, setValue] = useState("");
  return <OtpInput length={6} value={value} onChange={setValue} error={error} />;
}

function digit(idx: number): HTMLInputElement {
  return screen.getByRole("textbox", {
    name: `Digit ${idx + 1} of 6`,
  }) as HTMLInputElement;
}

describe("OtpInput accessibility", () => {
  it("CA-1 exposes the group with the accessible name Enter OTP", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Enter OTP" })).toBeTruthy();
  });

  it("CA-2 names every digit 1..6 of 6", () => {
    render(<Harness />);
    for (let i = 0; i < 6; i += 1) {
      expect(digit(i)).toBeTruthy();
    }
    expect(screen.queryByRole("textbox", { name: "Digit 7 of 6" })).toBeNull();
  });

  it("CA-2 exposes no error state when error is absent", () => {
    render(<Harness />);
    expect(screen.queryByRole("alert")).toBeNull();
    for (let i = 0; i < 6; i += 1) {
      expect(digit(i)).not.toHaveAttribute("aria-invalid");
      expect(digit(i)).not.toHaveAttribute("aria-describedby");
    }
  });

  it("CA-2 flags invalid digits and associates the alert error", () => {
    render(<Harness error="Incorrect OTP" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Incorrect OTP");
    expect(alert).toHaveAttribute("id", "otp-error");
    for (let i = 0; i < 6; i += 1) {
      expect(digit(i)).toHaveAttribute("aria-invalid", "true");
      expect(digit(i)).toHaveAttribute("aria-describedby", "otp-error");
    }
  });

  it("CA-3 advances focus when a digit is typed", () => {
    render(<Harness />);
    fireEvent.change(digit(0), { target: { value: "4" } });
    expect(digit(0).value).toBe("4");
    expect(document.activeElement).toBe(digit(1));
  });

  it("CA-3 clears the current digit on Backspace", () => {
    render(<Harness />);
    fireEvent.change(digit(0), { target: { value: "1" } });
    fireEvent.change(digit(1), { target: { value: "2" } });
    expect(digit(1).value).toBe("2");

    fireEvent.keyDown(digit(1), { key: "Backspace" });
    expect(digit(1).value).toBe("");
    expect(digit(0).value).toBe("1");
  });

  it("CA-3 moves to the previous digit on Backspace when empty", () => {
    render(<Harness />);
    fireEvent.change(digit(0), { target: { value: "1" } });
    fireEvent.change(digit(1), { target: { value: "2" } });
    fireEvent.keyDown(digit(1), { key: "Backspace" });
    fireEvent.keyDown(digit(1), { key: "Backspace" });
    expect(digit(0).value).toBe("");
    expect(document.activeElement).toBe(digit(0));
  });

  it("CA-3 populates and focuses the last pasted digit", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Enter OTP" });
    fireEvent.paste(group, {
      clipboardData: { getData: () => "123456" },
    });
    expect(digit(0).value).toBe("1");
    expect(digit(5).value).toBe("6");
    expect(document.activeElement).toBe(digit(5));
  });
});
