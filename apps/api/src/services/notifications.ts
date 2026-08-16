import { onEvent } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type {
  VendorApplicationApprovedEvent,
  VendorApplicationRejectedEvent,
} from "@snakzap/types";
import {
  sharedNotificationRepo,
} from "../repositories/shared";
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

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;

/** Seam so a real transactional SMS provider can be plugged in later. */
async function sendSmsMessage(phone: string, message: string): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  // Integration point: call the transactional SMS provider here. The outbox
  // already guarantees delivery semantics; this seam only needs to report
  // success/failure for the drain loop.
  logger.info({ message: "notification_sms_dispatched", phone, body: message });
  return true;
}

/** Seam so a real email provider can be plugged in later. */
async function sendEmailMessage(to: string, body: string): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  // Integration point: call the transactional email provider here.
  logger.info({ message: "notification_email_dispatched", to, body });
  return true;
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

async function deliverOne(n: NotificationDTO): Promise<void> {
  try {
    const ok =
      n.channel === "sms"
        ? await sendSmsMessage(n.to_address, n.body)
        : await sendEmailMessage(n.to_address, n.body);
    if (ok) {
      await sharedNotificationRepo.markSent(n.id);
      return;
    }
    throw new Error("send returned false");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextAttempts = n.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await sharedNotificationRepo.markDead(n.id, message);
    } else {
      const backoffMs = BASE_BACKOFF_MS * 2 ** n.attempts;
      await sharedNotificationRepo.markRetryable(
        n.id,
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
