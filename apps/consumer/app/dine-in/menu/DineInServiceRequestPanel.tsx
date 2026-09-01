"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircleIcon,
  HandRaisedIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useAuthStore } from "@/lib/store";
import {
  createDineInServiceRequest,
  type DineInServiceRequestCreateType,
} from "@/lib/api";
import { useDineInStore } from "@/store/dineIn";
import { useDialogFocus } from "@/hooks/useDialogFocus";

// ============================================
// Dine-In service request panel + create flow (frozen UI5-B).
//
// Menu-level entry ("Need something?") in the menu header/shell area — never
// on food item cards. Opens a mobile-first bottom sheet exposing EXACTLY the
// seven customer-creatable request types (WATER, EXTRA_PLATE, CUTLERY, TISSUE,
// CLEAN_TABLE, CALL_STAFF, OTHER). BRING_BILL / acknowledge / complete / cancel
// are deliberately absent: the server owns those flows.
//
// Submission state machine IDLE -> SUBMITTING -> SUCCESS | ERROR:
//   - POST /service-requests with ONLY session_id + request_type (+ a trimmed
//     note for OTHER). No restaurant/table ids, token, status, caller id or
//     timestamps is ever sent.
//   - OTHER note rules: required after trim, max 500, validated client-side
//     before POST; the trimmed note is submitted. Non-OTHER omits note entirely.
//   - Bearer token reuses useAuthStore: in-memory token, else single-flight
//     silent refresh, else the existing /login flow (menu route preserved).
//   - One submission -> one POST (ref guard + disabled controls while in
//     flight). Success keeps the panel open for another request and shows a
//     truthful local confirmation ("Request sent") with PENDING-only status.
//     No ETA, staff identity, queue position, acknowledged/completed progress.
//   - Server authority: availability is never gated on cached sessionStatus;
//     the POST decides. SESSION_CLOSED_FOR_REQUEST maps to safe terminal copy
//     and cached status is never mutated.
//   - Context disappears (clear/change): the panel closes/resets safely and
//     never POSTs. All panel state is component-local — no store, no
//     persistence, no token in DOM.
// ============================================

export const DINE_IN_SERVICE_REQUEST_TYPES: Array<{
  label: string;
  value: DineInServiceRequestCreateType;
}> = [
  { label: "Water", value: "WATER" },
  { label: "Extra plate", value: "EXTRA_PLATE" },
  { label: "Cutlery", value: "CUTLERY" },
  { label: "Tissue", value: "TISSUE" },
  { label: "Clean table", value: "CLEAN_TABLE" },
  { label: "Call staff", value: "CALL_STAFF" },
  { label: "Other", value: "OTHER" },
];

export const DINE_IN_SERVICE_NOTE_MAX_LENGTH = 500;

type PanelPhase = "idle" | "submitting" | "success" | "error";
type PanelErrorKind =
  | "invalid_type"
  | "note_required"
  | "validation"
  | "session_closed"
  | "network";

// Safe mapped copy only — raw backend messages are never rendered. The
// defensive BRING_BILL_MANAGED_BY_BILL_FLOW code (unreachable through this UI)
// collapses to the generic safe failure like any other network error.
const PANEL_ERROR_COPY: Record<PanelErrorKind, string> = {
  invalid_type: "That request isn't supported.",
  note_required: "Please add a note for your request.",
  validation: "Please check your request and try again.",
  session_closed: "This session is no longer accepting requests.",
  network: "Something went wrong. Try again.",
};

function classifyRequestError(err: unknown): PanelErrorKind | "auth" {
  const e = err as { status?: number; code?: string };
  if (e.code === "UNAUTHORIZED" || e.status === 401) return "auth";
  if (e.code === "INVALID_REQUEST_TYPE") return "invalid_type";
  if (e.code === "OTHER_NOTE_REQUIRED") return "note_required";
  if (e.code === "VALIDATION_ERROR") return "validation";
  if (e.code === "SESSION_CLOSED_FOR_REQUEST") return "session_closed";
  return "network";
}

export function DineInServiceRequestPanel({
  sessionId,
}: {
  sessionId: string;
}) {
  const router = useRouter();
  const { accessToken, refreshAccessToken } = useAuthStore();
  const contextSessionId = useDineInStore((s) => s.context?.sessionId ?? null);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<DineInServiceRequestCreateType | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [errorKind, setErrorKind] = useState<PanelErrorKind>("network");
  const [confirmedLabel, setConfirmedLabel] = useState<string | null>(null);
  const [confirmedStatus, setConfirmedStatus] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const resetSelection = useCallback(() => {
    setSelected(null);
    setNote("");
    setNoteError(null);
    setErrorKind("network");
    setPhase("idle");
    setConfirmedLabel(null);
    setConfirmedStatus(null);
  }, []);

  const closePanel = useCallback(() => {
    if (submittingRef.current) return;
    setOpen(false);
    resetSelection();
  }, [resetSelection]);

  // UI5-B §12: a changed/cleared Dine-In context must close the panel safely
  // and never allow a POST against a stale session.
  useEffect(() => {
    if (open && contextSessionId !== sessionId) {
      closePanel();
    }
  }, [open, contextSessionId, sessionId, closePanel]);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    if (!selected) return;
    const ctx = useDineInStore.getState().context;
    if (!ctx) return;

    // OTHER note rules are enforced client-side BEFORE any POST.
    let noteToSend: string | undefined;
    if (selected === "OTHER") {
      const trimmed = note.trim();
      if (trimmed.length === 0) {
        setNoteError(PANEL_ERROR_COPY.note_required);
        return;
      }
      if (trimmed.length > DINE_IN_SERVICE_NOTE_MAX_LENGTH) {
        setNoteError(
          `Please keep your note to ${DINE_IN_SERVICE_NOTE_MAX_LENGTH} characters or fewer.`,
        );
        return;
      }
      noteToSend = trimmed;
    }
    setNoteError(null);

    submittingRef.current = true;
    setPhase("submitting");
    try {
      // Auth: reuse the in-memory token, else the single-flight silent
      // refresh, else the existing /login flow with the menu route preserved.
      let currentToken = accessToken;
      if (!currentToken) {
        const refreshed = await refreshAccessToken();
        currentToken = refreshed ? useAuthStore.getState().accessToken : null;
      }
      if (!currentToken) {
        setPhase("idle");
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      const outcome = await createDineInServiceRequest(
        ctx.sessionId,
        selected,
        noteToSend,
        currentToken,
      );
      // Truthful local confirmation only: the selected label and the returned
      // status rendered as "Pending" ONLY when it is PENDING. No fake history,
      // ETA, staff identity or queue position.
      const label = DINE_IN_SERVICE_REQUEST_TYPES.find(
        (t) => t.value === selected,
      )?.label;
      setConfirmedLabel(label ?? null);
      setConfirmedStatus(outcome.request.status);
      setPhase("success");
    } catch (err) {
      const kind = classifyRequestError(err);
      if (kind === "auth") {
        setPhase("idle");
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      setErrorKind(kind);
      setPhase("error");
    } finally {
      submittingRef.current = false;
    }
  }, [accessToken, refreshAccessToken, router, selected, note]);

  const handleSendAnother = useCallback(() => {
    if (submittingRef.current) return;
    resetSelection();
  }, [resetSelection]);

  const inFlight = phase === "submitting";
  const disabled = inFlight || !selected;
  // UI7-B Repair C: initial focus, Tab containment, Escape-to-close (ignored
  // while submitting — closePanel guards it too), focus restore, body scroll
  // lock. UI7-B Repair B: viewport-constrained panel (100dvh tracks the OS
  // keyboard) with internal scroll so the note/actions stay reachable.
  const dialogRef = useDialogFocus({
    open,
    onEscape: closePanel,
    escapeDisabled: inFlight,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-bold text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
      >
        <HandRaisedIcon className="h-4 w-4" aria-hidden="true" />
        Need something?
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/40"
            onClick={() => closePanel()}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Request something"
            tabIndex={-1}
            className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-elevation-3 dark:bg-neutral-900"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-extrabold text-neutral-900 dark:text-white">
                Request something
              </h2>
              <button
                type="button"
                onClick={() => closePanel()}
                aria-label="Close"
                className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <XMarkIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {phase === "success" ? (
              <div className="mt-4">
                <div
                  role="status"
                  className="rounded-2xl bg-green-500/10 p-4 text-center"
                >
                  <CheckCircleIcon
                    className="mx-auto h-8 w-8 text-green-600"
                    aria-hidden="true"
                  />
                  <p className="mt-1 text-sm font-bold text-green-700">
                    Request sent
                  </p>
                  {confirmedLabel && (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      {confirmedLabel}
                    </p>
                  )}
                  {confirmedStatus === "PENDING" && (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      Status: Pending
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSendAnother}
                  className="mt-3 w-full text-sm font-bold text-primary-600 underline-offset-2 hover:underline dark:text-primary-300"
                >
                  Send another request
                </button>
              </div>
            ) : (
              <>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  What do you need? A staff member will be on their way.
                </p>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  {DINE_IN_SERVICE_REQUEST_TYPES.map((t) => {
                    const isSelected = selected === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => {
                          setSelected(t.value);
                          setNoteError(null);
                          if (phase === "error") setPhase("idle");
                        }}
                        aria-pressed={isSelected}
                        disabled={inFlight}
                        aria-disabled={inFlight}
                        className={`rounded-2xl border px-3 py-3 text-sm font-bold transition ${
                          isSelected
                            ? "border-primary-500 bg-primary-500/10 text-primary-700 dark:text-primary-300"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                        }`}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>

                {selected === "OTHER" && (
                  <div className="mt-3">
                    <label
                      htmlFor="service-note"
                      className="text-xs font-semibold text-neutral-500 dark:text-neutral-400"
                    >
                      What do you need?
                    </label>
                    <textarea
                      id="service-note"
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value);
                        if (noteError) setNoteError(null);
                      }}
                      maxLength={DINE_IN_SERVICE_NOTE_MAX_LENGTH}
                      disabled={inFlight}
                      rows={3}
                      placeholder="Tell us what you need (required)"
                      className="mt-1 w-full rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-900 outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                    />
                    {noteError && (
                      <p
                        role="alert"
                        className="mt-1 text-xs font-semibold text-red-600"
                      >
                        {noteError}
                      </p>
                    )}
                    <p className="mt-1 text-right text-2xs text-neutral-400">
                      {note.length}/{DINE_IN_SERVICE_NOTE_MAX_LENGTH}
                    </p>
                  </div>
                )}

                {phase === "error" && (
                  <div
                    role="alert"
                    className="mt-3 rounded-2xl bg-red-50 p-3 dark:bg-red-950/40"
                  >
                    <p className="text-xs font-bold text-red-600">
                      {PANEL_ERROR_COPY[errorKind]}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      You can try again.
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={disabled}
                  aria-disabled={disabled}
                  className="btn-primary mt-4 min-h-[48px] w-full"
                >
                  {inFlight ? "Sending..." : "Send request"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
