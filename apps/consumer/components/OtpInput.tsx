"use client";

import { useRef, useEffect } from "react";

interface OtpInputProps {
  length: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
}

export function OtpInput({ length = 6, value, onChange, disabled, error }: OtpInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const digits = value.replace(/\D/g, "").slice(0, length).split("");

  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  function handleChange(idx: number, e: React.ChangeEvent<HTMLInputElement>) {
    const char = e.target.value.replace(/\D/g, "").slice(-1);
    if (!char) return;

    const arr = [...digits];
    arr[idx] = char;
    const next = arr.join("").slice(0, length);
    onChange(next);

    if (idx < length - 1 && char) {
      inputsRef.current[idx + 1]?.focus();
    }
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (digits[idx]) {
        const arr = [...digits];
        arr[idx] = "";
        onChange(arr.join(""));
      } else if (idx > 0) {
        const arr = [...digits];
        arr[idx - 1] = "";
        onChange(arr.join(""));
        inputsRef.current[idx - 1]?.focus();
      }
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowRight" && idx < length - 1) {
      inputsRef.current[idx + 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    onChange(pasted);
    const nextIdx = Math.min(pasted.length, length - 1);
    inputsRef.current[nextIdx]?.focus();
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-neutral-600">
        Enter OTP
      </label>
      <div className="flex justify-center gap-2" onPaste={handlePaste}>
        {Array.from({ length }, (_, idx) => {
          const char = digits[idx] ?? "";
          return (
            <input
              key={idx}
              ref={(el) => { inputsRef.current[idx] = el; }}
              type="tel"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={1}
              value={char}
              onChange={(e) => handleChange(idx, e)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              disabled={disabled}
              className={`h-12 w-10 rounded-xl border-2 text-center text-xl font-semibold text-neutral-800 outline-none transition-colors ${
                char
                  ? "border-primary-500 bg-primary-500/5"
                  : "border-primary-500/20 bg-white"
              } focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50`}
            />
          );
        })}
      </div>
      {error && <p className="text-center text-xs text-red-500">{error}</p>}
    </div>
  );
}
