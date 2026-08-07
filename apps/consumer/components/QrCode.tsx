"use client";

// Simple QR code display using a data URI from a text value.
// In production, this would use a proper QR library (qrcode).
// For Phase 1, we display the QR token as a text code + scannable label.

interface QrCodeProps {
  value: string;
  size?: number;
}

export function QrCode({ value, size = 200 }: QrCodeProps) {
  // Generate a simple QR-like pattern using the token hash
  // This is a placeholder - real QR codes need qrcode library
  const seed = value.split("").reduce((a, c) => a + c.charCodeAt(0), 0);

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        width={size}
        height={size}
        viewBox="0 0 21 21"
        className="rounded-xl bg-white p-2 shadow-md"
        role="img"
        aria-label="Pickup QR Code"
      >
        {/* Finder patterns (top-left, top-right, bottom-left) */}
        <rect x="0" y="0" width="7" height="7" fill="#0D9488" />
        <rect x="1" y="1" width="5" height="5" fill="white" />
        <rect x="2" y="2" width="3" height="3" fill="#0D9488" />

        <rect x="14" y="0" width="7" height="7" fill="#0D9488" />
        <rect x="15" y="1" width="5" height="5" fill="white" />
        <rect x="16" y="2" width="3" height="3" fill="#0D9488" />

        <rect x="0" y="14" width="7" height="7" fill="#0D9488" />
        <rect x="1" y="15" width="5" height="5" fill="white" />
        <rect x="2" y="16" width="3" height="3" fill="#0D9488" />

        {/* Data modules - deterministic pattern from seed */}
        {Array.from({ length: 7 }, (_, row) =>
          Array.from({ length: 7 }, (_, col) => {
            if (row < 3 && col < 3) return null; // skip finder
            if (row < 3 && col > 3) return null;
            if (row > 3 && col < 3) return null;
            const bit = (seed >> (row * 7 + col)) & 1;
            if (!bit) return null;
            return (
              <rect
                key={`${row}-${col}`}
                x={col + 7}
                y={row + 7}
                width="1"
                height="1"
                fill="#0D9488"
              />
            );
          }),
        )}
      </svg>
      <p className="text-xs text-neutral-400 font-mono break-all text-center max-w-[200px]">
        {value}
      </p>
    </div>
  );
}
