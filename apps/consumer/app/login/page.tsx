"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { PhoneInput } from "@/components/PhoneInput";
import { OtpInput } from "@/components/OtpInput";

export default function LoginPage() {
  const router = useRouter();
  const { login, sendOtp } = useAuthStore();

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [demoOtp, setDemoOtp] = useState("");

  const isPhoneValid = /^[0-9]{10,15}$/.test(phone);
  const isOtpComplete = otp.replace(/\D/g, "").length === 6;

  async function handleSendOtp() {
    if (!isPhoneValid || loading) return;
    setError("");
    setDemoOtp("");
    setLoading(true);
    try {
      const result = await sendOtp(phone);
      if (result.sent) {
        setOtpSent(true);
        setStep("otp");
        if (result.demoOtp) {
          setDemoOtp(result.demoOtp);
          setOtp(result.demoOtp);
        }
      } else {
        setError("Failed to send OTP. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send OTP");
    } finally {
      setLoading(false);
    }
  }

  function getRedirectPath(): string {
    if (typeof window === "undefined") return "/";
    const from = new URLSearchParams(window.location.search).get("from");
    return from && from.startsWith("/") && !from.startsWith("//") ? from : "/";
  }

  async function handleVerifyOtp() {
    if (!isOtpComplete || loading) return;
    setError("");
    setLoading(true);
    try {
      await login(phone, otp);
      router.replace(getRedirectPath());
    } catch (err) {
      setOtp("");
      setError(err instanceof Error ? err.message : "Invalid OTP");
    } finally {
      setLoading(false);
    }
  }

  function handleBackToPhone() {
    setStep("phone");
    setOtp("");
    setError("");
    setDemoOtp("");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-light px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-primary-700">SnakZap</h1>
          <p className="mt-2 text-sm text-neutral-500">
            {step === "phone"
              ? "Enter your phone number to sign in"
              : "Enter the 6-digit OTP sent to your phone"}
          </p>
        </div>

        <div className="space-y-6 rounded-2xl bg-white p-6 shadow-sm">
          {step === "phone" ? (
            <>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                disabled={loading}
              />
              <button
                type="button"
                onClick={handleSendOtp}
                disabled={!isPhoneValid || loading}
                className="w-full rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {loading ? "Sending..." : "Send OTP"}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleBackToPhone}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  Back
                </button>
                <p className="text-sm text-neutral-400">
                  +91 {phone}
                </p>
              </div>
              <OtpInput
                length={6}
                value={otp}
                onChange={setOtp}
                disabled={loading}
                error={error}
              />
              {demoOtp ? (
                <div
                  data-testid="demo-otp"
                  className="rounded-xl border border-dashed border-primary-300 bg-primary-50 px-4 py-3 text-center"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary-600">
                    Demo code (on-screen OTP)
                  </p>
                  <p className="mt-1 font-mono text-3xl font-bold tracking-[0.35em] text-primary-700">
                    {demoOtp}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Auto-filled — no SMS is sent in this preview
                  </p>
                </div>
              ) : (
                otpSent && (
                  <p className="text-center text-xs text-neutral-400">
                    No SMS is sent in this preview build
                  </p>
                )
              )}
              <button
                type="button"
                onClick={handleVerifyOtp}
                disabled={!isOtpComplete || loading}
                className="w-full rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Verify & Sign In"}
              </button>
            </>
          )}

          {error && step === "phone" && (
            <p className="text-center text-sm text-red-500">{error}</p>
          )}
        </div>
      </div>
    </main>
  );
}
