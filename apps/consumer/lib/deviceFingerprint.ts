"use client";

// ============================================
// Device Fingerprint (EOS Layer 2.3 - Device Binding)
// Generates a stable browser-identity used for JWT binding.
// Stored in localStorage for persistence across sessions.
// ============================================

const FP_KEY = "snakzap_device_fp";

function generateFingerprint(): string {
  const parts = [
    navigator.hardwareConcurrency?.toString() ?? "?",
    navigator.language ?? "?",
    navigator.platform ?? "?",
    screen.colorDepth?.toString() ?? "?",
    new Date().getTimezoneOffset().toString(),
  ];
  let hash = 0;
  const raw = parts.join("|");
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash |= 0;
  }
  return `fp_${Math.abs(hash).toString(36)}_${Date.now().toString(36)}`;
}

export function getDeviceFingerprint(): string {
  if (typeof window === "undefined") return "fp_server_unknown";
  let fp = localStorage.getItem(FP_KEY);
  if (!fp) {
    fp = generateFingerprint();
    localStorage.setItem(FP_KEY, fp);
  }
  return fp;
}
