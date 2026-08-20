"use client";

import { useState } from "react";
import {
  CheckIcon,
  DocumentDuplicateIcon,
  ShareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import type { Gift } from "@/lib/api";
import { formatINR } from "@/lib/pricing";

export function GiftSuccess({
  gift,
  onClose,
}: {
  gift: Gift;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/gift/${encodeURIComponent(gift.claim_token)}`
      : `/gift/${encodeURIComponent(gift.claim_token)}`;

  async function copy(text: string, which: "link" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast("Could not copy to clipboard", { duration: 3000 });
    }
  }

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${gift.item_snapshot.name} on SnakZap`,
          text: `I gifted you ${gift.item_snapshot.name} on SnakZap. Claim it here:`,
          url: link,
        });
      } else {
        await copy(link, "link");
      }
    } catch {
      // user dismissed the share sheet
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Gift sent"
        className="relative w-full max-w-md rounded-t-3xl bg-white p-6 text-center shadow-elevation-3 dark:bg-neutral-900"
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-4 top-4 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        )}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
          <CheckIcon className="h-8 w-8 text-green-500" />
        </div>
        <h2 className="mt-4 text-xl font-bold text-neutral-900 dark:text-white">Gift sent!</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Share the link or code — your friend claims it and pays nothing.
        </p>

        <div className="mt-4 rounded-xl bg-primary-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-primary-700">Gift code</p>
          <p className="mt-1 font-mono text-2xl font-extrabold tracking-[0.3em] text-primary-700">
            {gift.claim_code}
          </p>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block truncate text-xs text-primary-700/70 underline-offset-2 hover:underline dark:text-primary-400/70"
          >
            {link}
          </a>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void share()}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white"
          >
            <ShareIcon className="h-5 w-5" />
            Share gift
          </button>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void copy(link, "link")}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-primary-500/30 py-2.5 text-sm font-semibold text-primary-700 dark:text-primary-400"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              {copied === "link" ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={() => void copy(gift.claim_code, "code")}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-primary-500/30 py-2.5 text-sm font-semibold text-primary-700 dark:text-primary-400"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              {copied === "code" ? "Copied!" : "Copy code"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs text-neutral-400">
          Valid for 90 days · {formatINR(gift.price_paid)} paid
        </p>
      </div>
    </div>
  );
}

export default GiftSuccess;
