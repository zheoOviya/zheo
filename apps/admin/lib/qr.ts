"use client";

import QRCode from "qrcode";

// ============================================
// 2FA QR rendering. Uses the `qrcode` package's pure-JS core
// (QRCode.create) to build the module matrix and renders it as an SVG,
// mirroring the consumer app's proven pickup-QR approach. Level 'M'
// is enough for authenticator-app scanning.
// ============================================

export const QR_QUIET_ZONE_MODULES = 2;

export interface QrMatrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

export function createQrMatrix(payload: string): QrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  return {
    size,
    dark: (row, col) => qr.modules.get(row, col) === 1,
  };
}

/** SVG path for the module grid, padded by the quiet zone. */
export function qrSvgPath(matrix: QrMatrix): string {
  const { size } = matrix;
  const quiet = QR_QUIET_ZONE_MODULES;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix.dark(r, c)) {
        d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
  }
  return d.length > 0 ? d : "";
}

export function qrViewSize(matrix: QrMatrix): number {
  return matrix.size + QR_QUIET_ZONE_MODULES * 2;
}
