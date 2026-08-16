import Link from "next/link";
import { AccountEntry } from "./AccountEntry";

// ============================================
// Global header shared by every protected page.
// Owns the brand mark and the account entry point
// (sign in / sign up, account menu, suspension
// banner) so navigation and suspension messaging
// stay consistent across routes.
// ============================================

export function BrandMark() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="SnakZap home">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary-400 to-primary-700 text-white shadow-md shadow-primary-700/20">
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 3l8.5 8.5M12 8.5V21m0-12.5L20.5 3m-8.5 6.5a6.5 6.5 0 100-3M9 21h6"
          />
        </svg>
      </span>
      <span className="brand-wordmark">SnakZap</span>
    </Link>
  );
}

export function AppHeader() {
  return (
    <header className="mb-5 flex items-center justify-between">
      <BrandMark />
      <AccountEntry />
    </header>
  );
}
