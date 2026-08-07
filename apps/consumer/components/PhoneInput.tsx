"use client";

import { useState } from "react";

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function PhoneInput({ value, onChange, disabled }: PhoneInputProps) {
  const [focused, setFocused] = useState(false);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 15);
    onChange(raw);
  }

  const isValid = /^[0-9]{10,15}$/.test(value);

  return (
    <div className="space-y-1">
      <label
        htmlFor="phone-input"
        className="text-sm font-medium text-neutral-600"
      >
        Phone Number
      </label>
      <div
        className={`flex items-center overflow-hidden rounded-xl border-2 bg-white transition-colors ${
          focused
            ? "border-primary-500"
            : isValid && value.length > 0
              ? "border-primary-500/30"
              : "border-primary-500/20"
        }`}
      >
        <span className="pl-4 text-lg text-neutral-400">+91</span>
        <input
          id="phone-input"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="9876543210"
          value={value}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          className="w-full bg-transparent px-3 py-3.5 text-lg text-neutral-800 placeholder-neutral-300 outline-none disabled:opacity-50"
        />
      </div>
      {value.length > 0 && !isValid && (
        <p className="text-xs text-red-500">Enter a valid 10-15 digit phone number</p>
      )}
    </div>
  );
}
