"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  confirmTotp,
  disableTotp,
  enrollTotp,
  getTotpStatus,
  type TotpStatus,
} from "../../../lib/totp";
import { createQrMatrix, qrSvgPath, qrViewSize } from "../../../lib/qr";

function QrSvg({ otpauthUrl }: { otpauthUrl: string }) {
  const matrix = useMemo(() => createQrMatrix(otpauthUrl), [otpauthUrl]);
  const viewSize = qrViewSize(matrix);
  return (
    <svg
      width={200}
      height={200}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      role="img"
      aria-label="2FA setup QR code"
      className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white p-2"
    >
      <path d={qrSvgPath(matrix)} fill="currentColor" className="text-neutral-900 dark:text-neutral-100" />
    </svg>
  );
}

function CodeInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={6}
      placeholder={placeholder ?? "000000"}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      disabled={disabled}
      className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-center text-lg tracking-[0.5em] text-neutral-900 dark:text-neutral-100 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
    />
  );
}

export default function SecurityPage() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [enrollResult, setEnrollResult] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getTotpStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load 2FA status"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function startEnroll() {
    setBusy(true);
    setError("");
    try {
      setEnrollResult(await enrollTotp());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start 2FA setup");
    } finally {
      setBusy(false);
    }
  }

  async function submitConfirm() {
    if (confirmCode.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await confirmTotp(confirmCode);
      setConfirmCode("");
      setEnrollResult(null);
      setStatus({ totp_enabled: true, enrolled: true, totp_confirmed_at: new Date().toISOString() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to confirm 2FA");
      setConfirmCode("");
    } finally {
      setBusy(false);
    }
  }

  async function submitDisable() {
    if (disableCode.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await disableTotp(disableCode);
      setDisableCode("");
      setStatus({ totp_enabled: false, enrolled: false, totp_confirmed_at: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disable 2FA");
      setDisableCode("");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          Security
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Two-factor authentication with your authenticator app (Google
          Authenticator, Authy, 1Password, etc.).
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {status?.totp_enabled ? (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 rounded-full bg-emerald-500" aria-hidden="true" />
            <div>
              <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                Two-factor authentication is enabled
              </p>
              <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-500">
                {status.totp_confirmed_at
                  ? `Confirmed ${new Date(status.totp_confirmed_at).toLocaleString()}`
                  : "Active on this account"}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              To disable, enter a current code from your authenticator app.
            </p>
            <CodeInput value={disableCode} onChange={setDisableCode} disabled={busy} />
            <button
              onClick={submitDisable}
              disabled={busy || disableCode.length !== 6}
              className="w-full rounded-lg border border-red-300 dark:border-red-700 bg-red-500 hover:bg-red-600 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              {busy ? "Disabling..." : "Disable 2FA"}
            </button>
          </div>
        </div>
      ) : enrollResult ? (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
          <div>
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">
              Scan with your authenticator app
            </h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Scan the QR code below, or enter the secret manually, then enter
              the 6-digit code to confirm.
            </p>
          </div>
          <QrSvg otpauthUrl={enrollResult.otpauth_url} />
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
              Manual entry secret
            </p>
            <p className="mt-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 px-3 py-2 font-mono text-sm break-all text-neutral-800 dark:text-neutral-200">
              {enrollResult.secret}
            </p>
          </div>
          <div className="space-y-3">
            <CodeInput value={confirmCode} onChange={setConfirmCode} disabled={busy} />
            <button
              onClick={submitConfirm}
              disabled={busy || confirmCode.length !== 6}
              className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              {busy ? "Confirming..." : "Confirm & Enable"}
            </button>
            <button
              onClick={() => { setEnrollResult(null); setConfirmCode(""); setError(""); }}
              disabled={busy}
              className="w-full text-sm text-neutral-500 dark:text-neutral-400 hover:text-primary-500 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex h-3 w-3 rounded-full bg-neutral-400 mt-1.5" aria-hidden="true" />
            <div>
              <p className="font-semibold text-neutral-900 dark:text-neutral-100">
                Two-factor authentication is off
              </p>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                Once enabled, sign-in requires both your SMS OTP and a code
                from your authenticator app. Recommended for admin accounts.
              </p>
            </div>
          </div>
          <button
            onClick={startEnroll}
            disabled={busy}
            className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            {busy ? "Preparing..." : "Set up 2FA"}
          </button>
        </div>
      )}
    </div>
  );
}
