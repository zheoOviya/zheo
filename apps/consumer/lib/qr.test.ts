import { describe, it, expect } from "vitest";
import jsQR from "jsqr";
import {
  createQrMatrix,
  qrPayload,
  matrixToImageData,
  QR_PAYLOAD_VERSION,
} from "./qr";

describe("qr payload encoding", () => {
  it("encodes { orderId, otp, v: 1 } as a JSON string", () => {
    const payload = qrPayload("order-0001", "482913");
    expect(JSON.parse(payload)).toEqual({
      orderId: "order-0001",
      otp: "482913",
      v: QR_PAYLOAD_VERSION,
    });
    expect(payload).toContain("482913");
  });
});

describe("qr scannability (I-02)", () => {
  it("round-trips through a real QR decoder (jsQR)", () => {
    const payload = qrPayload("7f3c0000-0000-4000-8000-000000000001", "733102");
    const matrix = createQrMatrix(payload);
    const image = matrixToImageData(matrix, 8, 4);

    const decoded = jsQR(image.data, image.width, image.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(payload);
  });

  it("produces a distinct matrix per payload", () => {
    const a = createQrMatrix(qrPayload("order-a", "111111"));
    const b = createQrMatrix(qrPayload("order-a", "222222"));
    const imgA = matrixToImageData(a, 2);
    const imgB = matrixToImageData(b, 2);
    expect(imgA.data).not.toEqual(imgB.data);
  });
});
