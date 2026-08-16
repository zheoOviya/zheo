"use client";

import { useState } from "react";
import Link from "next/link";
import {
  requestOtp,
  verifyOtpForApply,
  submitVendorApplication,
} from "@/lib/api";

type Step = "form" | "otp" | "done";

export default function VendorApplyPage() {
  const [step, setStep] = useState<Step>("form");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [demoOtp, setDemoOtp] = useState("");
  const [name, setName] = useState("");
  const [gst, setGst] = useState("");
  const [fssai, setFssai] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [type, setType] = useState<"SINGLE" | "CHAIN">("SINGLE");
  const [outletCount, setOutletCount] = useState(2);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendOtp() {
    setBusy(true);
    setError("");
    try {
      const demo = await requestOtp(phone);
      setDemoOtp(demo);
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send OTP");
    } finally {
      setBusy(false);
    }
  }

  async function confirmOtp() {
    setBusy(true);
    setError("");
    try {
      const token = await verifyOtpForApply(phone, otp);
      await submitVendorApplication(token, {
        name,
        gst_number: gst,
        fssai_license: fssai,
        phone,
        contact_email: email || undefined,
        city: city || undefined,
        address: address || undefined,
        type,
        outlet_count: type === "CHAIN" ? outletCount : 1,
      });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Application failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-lg font-bold text-slate-900">Partner with SnakZap</h1>
      <p className="mt-1 text-sm text-slate-500">
        Apply to onboard your restaurant. Our team reviews and approves applications.
      </p>

      <p className="mt-3 text-sm text-slate-500">
        Already a partner?{" "}
        <Link href="/login" className="font-semibold text-teal-600 hover:underline">
          Sign in
        </Link>
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {step === "form" && (
        <div className="mt-6 space-y-4">
          <Field label="Restaurant name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="e.g. Spice Route" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="GST number">
              <input value={gst} onChange={(e) => setGst(e.target.value)} className={inputClass} placeholder="27ABCDE1234F1Z5" />
            </Field>
            <Field label="FSSAI license">
              <input value={fssai} onChange={(e) => setFssai(e.target.value)} className={inputClass} placeholder="11522000000000" />
            </Field>
          </div>
          <Field label="Owner phone (for OTP login)">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="+91XXXXXXXXXX" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Contact email (optional)">
              <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="owner@restaurant.com" />
            </Field>
            <Field label="City (optional)">
              <input value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} placeholder="Mumbai" />
            </Field>
          </div>
          <Field label="Address (optional)">
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} placeholder="12 Linking Road, Bandra" />
          </Field>

          <Field label="Business type">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType("SINGLE")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                  type === "SINGLE"
                    ? "border-teal-500 bg-teal-50 text-teal-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                Single outlet
              </button>
              <button
                type="button"
                onClick={() => setType("CHAIN")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                  type === "CHAIN"
                    ? "border-teal-500 bg-teal-50 text-teal-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                Chain (multi-outlet)
              </button>
            </div>
          </Field>

          {type === "CHAIN" && (
            <Field label="Number of outlets">
              <input
                type="number"
                min={2}
                max={50}
                value={outletCount}
                onChange={(e) => setOutletCount(Math.max(2, Math.min(50, Number(e.target.value) || 2)))}
                className={inputClass}
              />
            </Field>
          )}

          <button
            onClick={sendOtp}
            disabled={busy || !name || !gst || !fssai || !phone}
            className="mt-2 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Sending OTP..." : "Send OTP & apply"}
          </button>
        </div>
      )}

      {step === "otp" && (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-slate-500">
            Enter the 6-digit code sent to {phone}.
            {demoOtp && (
              <span className="mt-1 block text-xs text-slate-400">Demo code: {demoOtp}</span>
            )}
          </p>
          <Field label="OTP code">
            <input value={otp} onChange={(e) => setOtp(e.target.value)} className={inputClass} placeholder="000000" maxLength={6} />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("form")}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Back
            </button>
            <button
              onClick={confirmOtp}
              disabled={busy || otp.length !== 6}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
            >
              {busy ? "Submitting..." : "Verify & submit"}
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
          Application submitted. Our team will review it and you will be notified once
          your restaurant is approved.
          <div className="mt-4">
            <Link href="/" className="font-semibold text-teal-600 hover:underline">
              Back to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20";
