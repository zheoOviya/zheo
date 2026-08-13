import { describe, expect, it } from "vitest";
import { createQrMatrix, qrSvgPath, qrViewSize } from "./qr";

describe("admin QR lib", () => {
  it("builds a scannable matrix from an otpauth URL", () => {
    const matrix = createQrMatrix(
      "otpauth://totp/SnakZap:+919876000000?secret=JBSWY3DPEHPK3PXP&issuer=SnakZap",
    );
    expect(matrix.size).toBeGreaterThan(10);
    expect(matrix.dark(0, 0)).toBe(true);
  });

  it("renders an SVG path covering dark modules", () => {
    const matrix = createQrMatrix("otpauth://totp/seed");
    const path = qrSvgPath(matrix);
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain("M");
    expect(path).toContain("h1v1h-1z");
  });

  it("adds a quiet zone to the view size", () => {
    const matrix = createQrMatrix("otpauth://totp/seed");
    expect(qrViewSize(matrix)).toBe(matrix.size + 4);
  });
});
