"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { storeSession } from "../../lib/auth";
import { sendAdminOtp, verifyAdminOtp } from "../../lib/authFlow";
import { verifyTotpLogin } from "../../lib/totp";

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

type Step = "email" | "otp" | "totp";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpTicket, setTotpTicket] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneMasked, setPhoneMasked] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoOtp, setDemoOtp] = useState("");

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  async function sendOtp() {
    setError("");
    setLoading(true);
    try {
      const result = await sendAdminOtp(email);
      setPhoneMasked(result.phoneMasked);
      if (result.demoOtp) {
        setDemoOtp(result.demoOtp);
        setOtp(result.demoOtp);
      }
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
      const result = await verifyAdminOtp({
        email,
        otp,
        device_fingerprint: getDeviceFingerprint(),
      });
      if (result.totp_required) {
        // 2FA step-up: stash the ticket + phone, ask for the authenticator code.
        setTotpTicket(result.totp_ticket ?? "");
        setPhone(result.phone ?? "");
        setStep("totp");
        return;
      }
      storeSession(result.access_token!);
      router.replace("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  async function verifyTotp() {
    setError("");
    setLoading(true);
    try {
      const result = await verifyTotpLogin({
        totp_ticket: totpTicket,
        code: totpCode,
        device_fingerprint: getDeviceFingerprint(),
        phone,
      });
      storeSession(result.access_token);
      router.replace("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setTotpCode("");
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
            {step === "email" && "Sign in with your operator email"}
            {step === "otp" && "Enter the OTP sent to your mobile"}
            {step === "totp" && "Enter your authenticator code"}
          </p>
        </div>

        {step === "email" && (
          <div className="space-y-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Email Address
            </label>
            <input
              type="email"
              placeholder="admin@snakzap.dev"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
              disabled={loading}
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2.5 text-xs text-neutral-500 dark:text-neutral-400">
              <p className="font-semibold uppercase tracking-wide">Demo accounts</p>
              <p className="mt-1 font-mono">admin@snakzap.dev — Admin</p>
              <p className="font-mono">superadmin@snakzap.dev — Super Admin</p>
              <p className="mt-1 text-neutral-400">
                The OTP is sent to the linked mobile number. Any 6-digit code
                works in this preview and auto-fills on the next step.
              </p>
            </div>
            <button
              onClick={sendOtp}
              disabled={loading || !emailValid}
              className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-3 text-sm font-semibold text-white transition-colors"
            >
              {loading ? "Sending..." : "Send OTP"}
            </button>
          </div>
        )}

        {step === "otp" && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400 text-center">
              OTP sent to {phoneMasked || "your linked mobile number"} for{" "}
              <span className="font-medium">{email}</span>
            </p>
            {demoOtp && (
              <div className="rounded-xl border border-dashed border-primary-300 dark:border-primary-800 bg-primary-50 dark:bg-primary-950 px-4 py-3 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">
                  Demo code (on-screen OTP)
                </p>
                <p className="mt-1 font-mono text-3xl font-bold tracking-[0.35em] text-primary-700 dark:text-primary-300">
                  {demoOtp}
                </p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Auto-filled — no SMS is sent in this preview
                </p>
              </div>
            )}
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
              {loading ? "Verifying..." : "Continue"}
            </button>
            <button
              onClick={() => { setStep("email"); setError(""); setDemoOtp(""); }}
              className="w-full text-sm text-neutral-500 dark:text-neutral-400 hover:text-primary-500 transition-colors"
            >
              Change email
            </button>
          </div>
        )}

        {step === "totp" && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400 text-center">
              This account requires a second factor. Enter the 6-digit code
              from your authenticator app.
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-center text-lg tracking-[0.5em] text-neutral-900 dark:text-neutral-100 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
              disabled={loading}
            />
            {error && <p className="text-sm text-red-500 text-center">{error}</p>}
            <button
              onClick={verifyTotp}
              disabled={loading || totpCode.length !== 6}
              className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-3 text-sm font-semibold text-white transition-colors"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
            <button
              onClick={() => { setStep("email"); setError(""); setTotpCode(""); }}
              className="w-full text-sm text-neutral-500 dark:text-neutral-400 hover:text-primary-500 transition-colors"
            >
              Back to email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
