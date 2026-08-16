"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAuthenticated, storeSession, getDeviceFingerprint } from "@/lib/auth";
import { ApiError, vendorSendOtp, vendorSignup, vendorVerifyOtp } from "@/lib/api";
import { useVendorStore } from "@/lib/store";

// ============================================
// Vendor sign-in / sign-up (phone + OTP).
// A new merchant signs up simply by entering a
// phone that has no vendor account yet: the first
// "Send OTP" creates a PENDING_VENDOR account, then
// OTP verification signs them in. Existing merchants
// (VENDOR_OWNER / VENDOR_STAFF / PENDING_VENDOR)
// sign in with the same phone+OTP flow.
// ============================================

export default function VendorLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [demoOtp, setDemoOtp] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace("/");
  }, [router]);

  async function sendOtp() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let demo = "";
      try {
        demo = await vendorSendOtp(phone);
      } catch (e) {
        if (e instanceof ApiError && e.code === "VENDOR_NOT_FOUND") {
          await vendorSignup(phone);
          setNotice("New merchant account created. Enter the OTP to sign in.");
          demo = await vendorSendOtp(phone);
        } else {
          throw e;
        }
      }
      setDemoOtp(demo);
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send OTP");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    setError("");
    try {
      const { access_token, user } = await vendorVerifyOtp(
        phone,
        otp,
        getDeviceFingerprint(),
      );
      storeSession(access_token, user);
      useVendorStore.getState().reset();
      router.replace(user.role === "PENDING_VENDOR" ? "/apply/status" : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "OTP verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-6 py-12 text-center">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8">
        <h1 className="text-lg font-bold text-primary-400">SnakZap Merchant</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {step === "phone"
            ? "Sign in with your phone number. New here? We will create your account automatically."
            : `Enter the 6-digit code sent to ${phone}.`}
        </p>

        {step === "phone" && (
          <div className="mt-4 rounded-lg border border-primary-500/20 bg-primary-500/10 px-3 py-2.5 text-left text-xs text-primary-200">
            <p className="font-semibold uppercase tracking-wide">Demo access</p>
            <p className="mt-1 font-mono text-primary-300">+919876000001 — Vendor Owner</p>
            <p className="mt-1 text-neutral-400">
              Any 6-digit code works in this preview. The on-screen demo code
              appears on the next step.
            </p>
          </div>
        )}

        {notice && (
          <div className="mt-4 rounded-lg border border-primary-500/40 bg-primary-500/10 p-3 text-sm text-primary-300">
            {notice}
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (step === "phone") void sendOtp();
            else void verifyOtp();
          }}
        >
          {step === "phone" ? (
            <label className="block text-left text-sm">
              <span className="mb-1 block font-medium text-neutral-300">Phone number</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-white outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder="+91XXXXXXXXXX"
                inputMode="tel"
                autoComplete="tel"
              />
            </label>
          ) : (
            <label className="block text-left text-sm">
              <span className="mb-1 block font-medium text-neutral-300">OTP code</span>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-white outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder="000000"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
              />
              {demoOtp && (
                <span className="mt-1 block text-xs text-neutral-500">Demo code: {demoOtp}</span>
              )}
            </label>
          )}

          <button
            type="submit"
            disabled={busy || (step === "phone" ? phone.trim().length < 10 : otp.length !== 6)}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-primary px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? "Please wait..." : step === "phone" ? "Send OTP" : "Verify & sign in"}
          </button>

          {step === "otp" && (
            <button
              type="button"
              onClick={() => setStep("phone")}
              className="w-full text-sm font-semibold text-neutral-400 hover:text-neutral-200"
            >
              Change phone number
            </button>
          )}
        </form>

        <p className="mt-6 text-xs text-neutral-500">
          New to SnakZap?{" "}
          <Link href="/apply" className="font-semibold text-primary-400 hover:underline">
            Apply to onboard your restaurant
          </Link>
        </p>
      </div>
    </main>
  );
}
