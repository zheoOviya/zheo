import { onEvent } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type {
  VendorApplicationApprovedEvent,
  VendorApplicationRejectedEvent,
} from "@snakzap/types";
import {
  sharedNotificationRepo,
} from "../repositories/shared";
import { NOTIFICATION_MAX_ATTEMPTS } from "../repositories/notificationRepository";
import type {
  EnqueueNotificationInput,
  NotificationDTO,
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

// No real SMS/email provider is wired in this build. Outside of test mode a
// send therefore fails closed instead of reporting a delivery that never
// happened: the caller's existing retry/backoff/dead policy applies and no
// success log is emitted. NODE_ENV=test keeps a deterministic fake success so
// the unit suite does not need a live provider. A real adapter may be plugged
// into these two seams later; until then nothing may claim a message was sent.

/** Provider seam: true only when a real (or test-fake) delivery succeeded. */
export async function sendSmsMessage(phone: string, _message: string): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  logger.error({ message: "notification_sms_provider_unconfigured", phone });
  throw new Error("sms provider not configured");
}

/** Provider seam: true only when a real (or test-fake) delivery succeeded. */
export async function sendEmailMessage(to: string, _body: string): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  logger.error({ message: "notification_email_provider_unconfigured", to });
  throw new Error("email provider not configured");
}

let draining = false;

export async function drainNotifications(limit = 50): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const pending = await sharedNotificationRepo.listPending(limit);
    for (const n of pending) {
      await deliverOne(n);
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
 */
export async function deliverOne(n: NotificationDTO): Promise<void> {
  const reserved = await sharedNotificationRepo.reserveAttempt(n.id, n.attempts, new Date());
  if (!reserved) return;
  try {
    const ok =
      reserved.channel === "sms"
        ? await sendSmsMessage(reserved.to_address, reserved.body)
        : await sendEmailMessage(reserved.to_address, reserved.body);
    if (ok) {
      await sharedNotificationRepo.markSent(reserved.id, reserved.attempts);
      return;
    }
    throw new Error("send returned false");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (reserved.attempts >= MAX_ATTEMPTS) {
      await sharedNotificationRepo.markDead(reserved.id, reserved.attempts, message);
    } else {
      const backoffMs = BASE_BACKOFF_MS * 2 ** (reserved.attempts - 1);
      await sharedNotificationRepo.markRetryable(
        reserved.id,
        reserved.attempts,
        message,
        new Date(Date.now() + backoffMs),
      );
    }
  }
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
