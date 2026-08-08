"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { storeSession } from "../../lib/auth";

const FP_STORAGE_KEY = "snakzap_admin_device_fingerprint";

function getDeviceFingerprint(): string {
  try {
    const existing = window.localStorage.getItem(FP_STORAGE_KEY);
    if (existing) return existing;
    const fresh = "admin-console-" + crypto.randomUUID();
    window.localStorage.setItem(FP_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return "admin-console-" + crypto.randomUUID();
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendOtp() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error?.message ?? "Failed to send OTP");
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          otp,
          device_fingerprint: getDeviceFingerprint(),
        }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error?.message ?? "Verification failed");
      storeSession(body.data.access_token);
      router.replace("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-light dark:bg-surface-dark px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-neutral-900 p-8 shadow-lg border border-neutral-200 dark:border-neutral-800">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-primary-500">SnakZap Admin</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Sign in with your phone number
          </p>
        </div>

        {step === "phone" ? (
          <div className="space-y-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Phone Number
            </label>
            <input
              type="tel"
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
              disabled={loading}
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button
              onClick={sendOtp}
              disabled={loading || phone.length < 10}
              className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-3 text-sm font-semibold text-white transition-colors"
            >
              {loading ? "Sending..." : "Send OTP"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400 text-center">
              Enter the 6-digit code sent to {phone}
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-center text-lg tracking-[0.5em] text-neutral-900 dark:text-neutral-100 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
              disabled={loading}
            />
            {error && <p className="text-sm text-red-500 text-center">{error}</p>}
            <button
              onClick={verifyOtp}
              disabled={loading || otp.length !== 6}
              className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-3 text-sm font-semibold text-white transition-colors"
            >
              {loading ? "Verifying..." : "Sign In"}
            </button>
            <button
              onClick={() => { setStep("phone"); setError(""); }}
              className="w-full text-sm text-neutral-500 dark:text-neutral-400 hover:text-primary-500 transition-colors"
            >
              Change phone number
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
