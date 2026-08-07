"use client";

import { useEffect, useState } from "react";
import { createQrMatrix, qrPayload, qrSvgPath, qrViewSize } from "@/lib/qr";

// I-02 Real QR code. Tap the code to open a fullscreen modal with a larger
// render, a "Max Brightness" boost (for dim restaurant counters), the pickup
// OTP in large monospace, and a one-tap "Copy OTP" action.

interface QrCodeProps {
  orderId: string;
  otp: string;
  size?: number;
}

export function QrCode({ orderId, otp, size = 200 }: QrCodeProps) {
  const [open, setOpen] = useState(false);
  const matrix = createQrMatrix(qrPayload(orderId, otp));
  const viewSize = qrViewSize(matrix);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Enlarge pickup QR code"
        className="group flex flex-col items-center gap-3 rounded-xl p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${viewSize} ${viewSize}`}
          className="rounded-xl bg-white p-2 shadow-md"
          role="img"
          aria-label="Pickup QR Code"
        >
          <rect width={viewSize} height={viewSize} fill="white" />
          <path d={qrSvgPath(matrix)} fill="#0D9488" />
        </svg>
        <span className="text-xs font-medium text-primary-600 group-hover:text-primary-hover">
          Tap to enlarge
        </span>
      </button>

      {open && (
        <QrModal
          orderId={orderId}
          otp={otp}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function QrModal({
  orderId,
  otp,
  onClose,
}: {
  orderId: string;
  otp: string;
  onClose: () => void;
}) {
  const [bright, setBright] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const matrix = createQrMatrix(qrPayload(orderId, otp));
  const viewSize = qrViewSize(matrix);

  async function copyOtp() {
    try {
      await navigator.clipboard.writeText(otp);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable - OTP stays visible on screen for manual entry.
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pickup QR code"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={bright ? { filter: "brightness(1.6)" } : undefined}
        className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-neutral-700">
          Show this at the counter
        </h2>

        <div className="mx-auto mt-5 w-fit rounded-2xl bg-white p-3 ring-1 ring-neutral-100">
          <svg
            width={280}
            height={280}
            viewBox={`0 0 ${viewSize} ${viewSize}`}
            role="img"
            aria-label="Pickup QR code large"
          >
            <rect width={viewSize} height={viewSize} fill="white" />
            <path d={qrSvgPath(matrix)} fill="#0D9488" />
          </svg>
        </div>

        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          Pickup Code
        </p>
        <p className="mt-1 text-4xl font-bold tracking-[0.2em] text-primary-700">
          {otp}
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => setBright((v) => !v)}
            aria-pressed={bright}
            className="flex-1 rounded-full border border-primary-500/30 py-2.5 text-sm font-semibold text-primary-700 hover:bg-surface-light"
          >
            {bright ? "Max Brightness On" : "Max Brightness"}
          </button>
          <button
            type="button"
            onClick={copyOtp}
            className="flex-1 rounded-full bg-primary-500 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            {copied ? "Copied!" : "Copy OTP"}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 text-sm text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
        >
          Close
        </button>
      </div>
    </div>
  );
}
