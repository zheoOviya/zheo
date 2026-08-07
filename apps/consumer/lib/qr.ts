import QRCode from "qrcode";

// ============================================
// Real QR generation (I-02). Uses the `qrcode` package's pure-JS core
// (`QRCode.create`) to build the module matrix and renders it as an SVG -
// a genuine, scannable QR code (no canvas dependency). Error correction
// level 'H' matches the pickup-counter scan robustness requirement.
// ============================================

export const QR_ERROR_CORRECTION_LEVEL = "H" as const;
export const QR_PAYLOAD_VERSION = 1;
export const QR_QUIET_ZONE_MODULES = 4;

export interface QrMatrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

/** Encodes the pickup QR payload: { orderId, otp, v: 1 } as JSON. */
export function qrPayload(orderId: string, otp: string): string {
  return JSON.stringify({
    orderId,
    otp,
    v: QR_PAYLOAD_VERSION,
  });
}

export function createQrMatrix(payload: string): QrMatrix {
  const qr = QRCode.create(payload, {
    errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
  });
  const size = qr.modules.size;
  return {
    size,
    dark: (row, col) => qr.modules.get(row, col) === 1,
  };
}

/** SVG path for the module grid, padded by the standard 4-module quiet zone. */
export function qrSvgPath(matrix: QrMatrix): string {
  const { size } = matrix;
  const quiet = QR_QUIET_ZONE_MODULES;
  const viewSize = size + quiet * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix.dark(r, c)) {
        d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
  }
  return d.length > 0 ? d : `M0 0h${viewSize}v${viewSize}h-${viewSize}z`;
}

export function qrViewSize(matrix: QrMatrix): number {
  return matrix.size + QR_QUIET_ZONE_MODULES * 2;
}

/**
 * Rebuild a black-and-white RGBA image buffer from the module matrix.
 * Used by tests to prove the QR code actually decodes (jsQR round-trip).
 */
export function matrixToImageData(
  matrix: QrMatrix,
  scale = 8,
  quiet = QR_QUIET_ZONE_MODULES,
): { data: Uint8ClampedArray; width: number; height: number } {
  const dim = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const row = Math.floor(y / scale) - quiet;
      const col = Math.floor(x / scale) - quiet;
      const isDark =
        row >= 0 &&
        col >= 0 &&
        row < matrix.size &&
        col < matrix.size &&
        matrix.dark(row, col);
      const idx = (y * dim + x) * 4;
      data[idx] = isDark ? 0 : 255;
      data[idx + 1] = isDark ? 0 : 255;
      data[idx + 2] = isDark ? 0 : 255;
      data[idx + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}
