import { onEvent } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type {
  VendorApplicationApprovedEvent,
  VendorApplicationRejectedEvent,
} from "@snakzap/types";
import {
  sharedNotificationRepo,
} from "../repositories/shared";
import {
  NOTIFICATION_MAX_ATTEMPTS,
  classifyNotificationError,
} from "../repositories/notificationRepository";
import type {
  EnqueueNotificationInput,
  NotificationChannel,
  NotificationDTO,
  SafeErrorCategory,
} from "../repositories/notificationRepository";

// ============================================
// Vendor onboarding notifications (outbox)
// Subscribes to VendorApplicationApproved/Rejected and enqueues SMS/email
// into the notification outbox. Delivery is best-effort and never blocks the
// admin request path: the handler writes to the outbox, then kicks off an
// asynchronous drain. Failed sends are retried with exponential backoff.
// ============================================

const MAX_ATTEMPTS = NOTIFICATION_MAX_ATTEMPTS;
const BASE_BACKOFF_MS = 30_000;

// Retry liveness (NOTIFICATION-RETRY-SWEEPER-A2). A retryable PENDING row
// stores a future next_attempt_at, but nothing wakes it on its own: delivery
// is otherwise only triggered by a new vendor event. A single unref'd periodic
// wakeup plus an immediate startup drain guarantees a due retry is revisited
// even when no unrelated event arrives. The repository reserveAttempt CAS
// stays the only concurrency guard, so overlapping event/startup/periodic
// drains remain safe and one winner calls the provider.
export const NOTIFICATION_RETRY_SWEEP_INTERVAL_MS = 30_000;

// No real SMS/email provider is wired in this build. Outside of test mode a
// send therefore fails closed instead of reporting a delivery that never
// happened: the caller's existing retry/backoff/dead policy applies and no
// success log is emitted. NODE_ENV=test keeps a deterministic fake success so
// the unit suite does not need a live provider. A real adapter may be plugged
// into these two seams later; until then nothing may claim a message was sent.

// --- Provider idempotency (NOTIFICATION-PROVIDER-IDEMPOTENCY-A2) ---
// The deterministic provider idempotency key is the notification's own
// immutable id. It is reused verbatim on every reserved attempt AND on the
// single final same-key confirmation call, so a provider that honors the key
// can collapse the at-least-once retry/ambiguity window into
// effectively-once delivery. Exactly-once is never claimed: without a real
// provider honoring the key (and a dedupe window covering the retry lifetime)
// the guarantee degrades to at-least-once / best-effort. The key never carries
// recipient PII: destination and body are passed as separate arguments and the
// only value logged is the key itself.

/** The four mandatory provider outcome semantics. */
export type NotificationProviderOutcome =
  | { kind: "ACCEPTED" }
  | { kind: "DEFINITIVE_FAILURE"; error: string }
  | { kind: "AMBIGUOUS"; error: string }
  | { kind: "CONFIG_ERROR"; error: string };

/**
 * Internal provider adapter seam: destination, body and idempotencyKey.
 * Scriptable in tests without wiring a real provider.
 */
export type NotificationProvider = (
  channel: NotificationChannel,
  toAddress: string,
  body: string,
  idempotencyKey: string,
) => Promise<NotificationProviderOutcome>;

/**
 * SMS seam. Test mode returns a deterministic fake ACCEPTED; without a real
 * adapter every other environment is fail-closed as CONFIG_ERROR. Never
 * ACCEPTED, and never throws for a missing provider.
 */
export async function sendSmsMessage(
  _phone: string,
  _message: string,
  idempotencyKey: string,
): Promise<NotificationProviderOutcome> {
  if (process.env.NODE_ENV === "test") return { kind: "ACCEPTED" };
  logger.error({ message: "notification_sms_provider_unconfigured", idempotencyKey });
  return { kind: "CONFIG_ERROR", error: "sms provider not configured" };
}

/**
 * Email seam. Same contract as the SMS seam: deterministic fake ACCEPTED in
 * tests, fail-closed CONFIG_ERROR everywhere else.
 */
export async function sendEmailMessage(
  _to: string,
  _body: string,
  idempotencyKey: string,
): Promise<NotificationProviderOutcome> {
  if (process.env.NODE_ENV === "test") return { kind: "ACCEPTED" };
  logger.error({ message: "notification_email_provider_unconfigured", idempotencyKey });
  return { kind: "CONFIG_ERROR", error: "email provider not configured" };
}

/** Default adapter dispatching to the channel seams. */
async function defaultNotificationProvider(
  channel: NotificationChannel,
  toAddress: string,
  body: string,
  idempotencyKey: string,
): Promise<NotificationProviderOutcome> {
  return channel === "sms"
    ? sendSmsMessage(toAddress, body, idempotencyKey)
    : sendEmailMessage(toAddress, body, idempotencyKey);
}

let provider: NotificationProvider = defaultNotificationProvider;

/**
 * Test-only injection point for scripting provider outcomes. Pass `null` to
 * restore the default adapter. Never exposed over HTTP/API. Tests MUST restore
 * it in afterEach/finally so no seam leak survives a suite.
 */
export function __setNotificationProviderForTests(next: NotificationProvider | null): void {
  provider = next ?? defaultNotificationProvider;
}

let draining = false;

/**
 * Drain the pending outbox. The process-local `draining` guard keeps overlapping
 * same-process drains from fanning out concurrently.
 *
 * Failure boundaries (NOTIFICATION-DRAIN-RESILIENCE-A2):
 * - listPending is batch-level: if it throws, that whole drain aborts and is
 *   reported once via `notification_drain_error`.
 * - Each `deliverOne` is item-level: an unexpected exception from a single
 *   item's reservation/state-persistence path is logged as
 *   `notification_delivery_item_error` and the loop continues, so one bad item
 *   can never starve the later eligible items in the same batch. No fabricated
 *   success, no forced FAILED, and no second state mutation are performed here;
 *   the existing provider-idempotency/retry protocol owns recovery.
 */
export async function drainNotifications(limit = 50): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const pending = await sharedNotificationRepo.listPending(limit);
    for (const n of pending) {
      try {
        await deliverOne(n);
      } catch (err) {
        logger.error({
          message: "notification_delivery_item_error",
          notification_id: n.id,
          channel: n.channel,
          attempts: n.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error({
      message: "notification_drain_error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    draining = false;
  }
}

/**
 * Attempt one delivery: atomically reserve the attempt BEFORE calling the
 * provider, then CAS the terminal/retry transition from that exact reserved
 * attempt. A concurrent worker that loses the reservation returns without
 * touching the provider or the row. Exported for the concurrency unit tests.
 *
 * `attempts` counts RESERVED application delivery attempts, not raw provider
 * invocations: a single final reserved attempt may issue one same-key
 * confirmation call, so provider calls are not always equal to attempts.
 */
export async function deliverOne(n: NotificationDTO): Promise<void> {
  const reserved = await sharedNotificationRepo.reserveAttempt(n.id, n.attempts, new Date());
  if (!reserved) return;

  // Same key for every attempt and for the final same-key confirmation.
  const idempotencyKey = reserved.id;

  const outcome = await invokeProvider(reserved, idempotencyKey);

  if (outcome.kind === "ACCEPTED") {
    await sharedNotificationRepo.markSent(reserved.id, reserved.attempts);
    return;
  }

  if (outcome.kind !== "AMBIGUOUS") {
    // DEFINITIVE_FAILURE / CONFIG_ERROR: definitive, no confirmation call.
    await retryOrDead(reserved, outcome.error);
    return;
  }

  if (reserved.attempts < MAX_ATTEMPTS) {
    // Ordinary ambiguity before the cap: schedule a retry that reuses the key.
    await retryOrDead(reserved, outcome.error);
    return;
  }

  // Final reserved attempt, first AMBIGUOUS result: MUST NOT markDead yet.
  // Exactly one immediate same-key confirmation call, no second reserveAttempt,
  // attempts stays MAX_ATTEMPTS, no unbounded loop.
  const confirmation = await invokeProvider(reserved, idempotencyKey);
  if (confirmation.kind === "ACCEPTED") {
    await sharedNotificationRepo.markSent(reserved.id, reserved.attempts);
    return;
  }
  const finalError =
    confirmation.kind === "AMBIGUOUS"
      ? `${outcome.error}; provider outcome ambiguous after final same-key confirmation`
      : confirmation.error;
  const dead = await sharedNotificationRepo.markDead(reserved.id, reserved.attempts, finalError);
  if (dead) logTerminalFailed(dead);
}

/**
 * Invoke the provider adapter. A structured outcome is passed through; an
 * unexpected throw is treated as AMBIGUOUS because the request may already have
 * been transmitted (never as ACCEPTED).
 */
async function invokeProvider(
  reserved: NotificationDTO,
  idempotencyKey: string,
): Promise<NotificationProviderOutcome> {
  try {
    return await provider(reserved.channel, reserved.to_address, reserved.body, idempotencyKey);
  } catch (err) {
    return {
      kind: "AMBIGUOUS",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lifecycle observability (NOTIFICATION-OPERABILITY-LIFECYCLE-A2).
 *
 * These logs describe PERSISTED truth, never an intended transition: a
 * `markRetryable`/`markDead` call alone proves nothing, only a non-null
 * repository transition result does. That is why every emit helper below takes
 * the returned persisted row and is called strictly after persistence. The
 * payloads are restricted to the frozen safe operational fields — no row id,
 * recipient, body, raw error, or idempotency key.
 */
function safeCategoryOf(persisted: NotificationDTO): SafeErrorCategory {
  return classifyNotificationError(persisted.last_error) ?? "UNKNOWN";
}

function logRetryScheduled(persisted: NotificationDTO): void {
  logger.info({
    message: "notification_retry_scheduled",
    channel: persisted.channel,
    attempts: persisted.attempts,
    safe_error_category: safeCategoryOf(persisted),
  });
}

function logTerminalFailed(persisted: NotificationDTO): void {
  logger.error({
    message: "notification_terminal_failed",
    channel: persisted.channel,
    attempts: persisted.attempts,
    safe_error_category: safeCategoryOf(persisted),
  });
}

/** Existing retry/backoff/dead policy, driven by the reserved attempt. */
async function retryOrDead(reserved: NotificationDTO, error: string): Promise<void> {
  if (reserved.attempts >= MAX_ATTEMPTS) {
    const dead = await sharedNotificationRepo.markDead(reserved.id, reserved.attempts, error);
    if (dead) logTerminalFailed(dead);
  } else {
    const backoffMs = BASE_BACKOFF_MS * 2 ** (reserved.attempts - 1);
    const retried = await sharedNotificationRepo.markRetryable(
      reserved.id,
      reserved.attempts,
      error,
      new Date(Date.now() + backoffMs),
    );
    if (retried) logRetryScheduled(retried);
  }
}

let retryTimer: NodeJS.Timeout | null = null;

/**
 * Start the notification retry sweep: drain once immediately, then wake again
 * every NOTIFICATION_RETRY_SWEEP_INTERVAL_MS. Idempotent — a second call while
 * running is a no-op. The timer is unref'd so it never keeps the process alive.
 * `drainNotifications` owns its own error handling, so starting the sweep never
 * throws into server bootstrap.
 */
export function startNotificationRetrySweep(): void {
  if (retryTimer) return;
  void drainNotifications();
  retryTimer = setInterval(() => {
    void drainNotifications();
  }, NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
  retryTimer.unref();
  logger.info({
    message: "notification_retry_sweep_started",
    interval_ms: NOTIFICATION_RETRY_SWEEP_INTERVAL_MS,
  });
}

/** Stop the retry sweep. Safe when not started, idempotent, no DB mutation. */
export function stopNotificationRetrySweep(): void {
  if (!retryTimer) return;
  clearInterval(retryTimer);
  retryTimer = null;
  logger.info({ message: "notification_retry_sweep_stopped" });
}

async function enqueue(input: EnqueueNotificationInput): Promise<void> {
  await sharedNotificationRepo.enqueue(input);
}

function approvedBody(name: string): string {
  return `SnakZap: your application for ${name} has been approved. You can now manage your restaurant from the vendor console.`;
}

function rejectedBody(name: string, reason: string | null): string {
  const why = reason ? ` Reason: ${reason}` : "";
  return `SnakZap: your application for ${name} was not approved.${why}`;
}

let registered = false;

export function registerVendorNotificationHandlers(): void {
  if (registered) return;
  registered = true;

  onEvent("VendorApplicationApproved", async (event) => {
    const p = event.payload as VendorApplicationApprovedEvent;
    await enqueue({
      user_id: p.applicant_id,
      channel: "sms",
      to_address: p.phone,
      body: approvedBody(p.name),
    });
    if (p.contact_email) {
      await enqueue({
        user_id: p.applicant_id,
        channel: "email",
        to_address: p.contact_email,
        body: approvedBody(p.name),
      });
    }
    void drainNotifications();
  });

  onEvent("VendorApplicationRejected", async (event) => {
    const p = event.payload as VendorApplicationRejectedEvent;
    await enqueue({
      user_id: p.applicant_id,
      channel: "sms",
      to_address: p.phone,
      body: rejectedBody(p.name, p.reason),
    });
    if (p.contact_email) {
      await enqueue({
        user_id: p.applicant_id,
        channel: "email",
        to_address: p.contact_email,
        body: rejectedBody(p.name, p.reason),
      });
    }
    void drainNotifications();
  });
}
