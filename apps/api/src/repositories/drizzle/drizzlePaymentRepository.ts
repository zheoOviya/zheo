import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { payments } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  PaymentRepository,
  PaymentDTO,
  CreatePaymentInput,
  WebhookUpdate,
  WebhookUpdateResult,
  LeaseAcquireResult,
  PaymentAttempt,
  PaymentStatus,
} from "../paymentRepository";
import { PaymentTargetConflictError, PAYMENT_STATUS_RANK } from "../paymentRepository";

// ============================================
// Payments context repository (Drizzle/Postgres)
// ============================================

function mapPaymentRow(row: Record<string, unknown>): PaymentDTO {
  const meta = (row.metadata as Record<string, unknown>) ?? {};
  return {
    id: row.id as string,
    order_id: (row.order_id as string | null) ?? null,
    gift_id: (row.gift_id as string | null) ?? null,
    razorpay_order_id: (row.provider_transaction_id as string | null) ?? null,
    razorpay_payment_id: (meta.razorpay_payment_id as string) ?? null,
    amount: Number(row.amount),
    currency: (meta.currency as string) ?? "INR",
    status: row.status as PaymentStatus,
    method: (meta.method as string) ?? null,
    webhook_event: (meta.webhook_event as string) ?? null,
    webhook_raw: (meta.webhook_raw as unknown) ?? null,
    attempts: Array.isArray(meta.attempts) ? (meta.attempts as PaymentAttempt[]) : [],
    receipt: (row.receipt as string) ?? "",
    lease_owner: (row.lease_owner as string) ?? null,
    lease_expires_at: row.lease_expires_at
      ? new Date(row.lease_expires_at as Date).toISOString()
      : null,
    created_at: new Date(row.created_at as Date | string).toISOString(),
    updated_at: row.updated_at
      ? new Date(row.updated_at as Date | string).toISOString()
      : new Date(row.created_at as Date | string).toISOString(),
  };
}

/** SQL fragment that atomically appends an attempt to metadata.attempts, computing seq from the current row. */
function attemptsAppend(attempt: Omit<PaymentAttempt, "seq">): ReturnType<typeof sql> {
  const attemptJson = JSON.stringify(attempt);
  return sql`jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{attempts}',
    COALESCE(metadata->'attempts', '[]'::jsonb) || jsonb_set(
      ${attemptJson}::jsonb,
      '{seq}',
      to_jsonb(jsonb_array_length(COALESCE(metadata->'attempts', '[]'::jsonb)) + 1)
    ),
    true
  )`;
}

/** Normalizes drizzle execute()/select() results into a plain row array. */
function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    const r = result as { rows?: unknown; row?: unknown };
    if (Array.isArray(r.rows)) return r.rows as Record<string, unknown>[];
    if (r.row) return [r.row as Record<string, unknown>];
  }
  return [];
}

export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createReservation(input: CreatePaymentInput): Promise<PaymentDTO> {
    const id = randomUUID();
    const now = new Date();
    const leaseTtl = input.leaseTtlMs ?? 30_000;
    try {
      const result = await this.db.insert(payments).values({
        id,
        order_id: input.order_id ?? null,
        gift_id: input.gift_id ?? null,
        provider: "razorpay",
        amount: String(input.amount),
        status: "INITIATING",
        receipt: input.receipt,
        lease_owner: input.lease_owner,
        lease_expires_at: new Date(now.getTime() + leaseTtl),
        metadata: {
          currency: input.currency ?? "INR",
          method: input.method ?? null,
          attempts: [
            {
              seq: 1,
              event: "initiation_started",
              at: now.toISOString(),
            },
          ],
        },
      });
      void result;
      return {
        id,
        order_id: input.order_id ?? null,
        gift_id: input.gift_id ?? null,
        razorpay_order_id: null,
        razorpay_payment_id: null,
        amount: input.amount,
        currency: input.currency ?? "INR",
        status: "INITIATING",
        method: input.method ?? null,
        webhook_event: null,
        webhook_raw: null,
        attempts: [{ seq: 1, event: "initiation_started", at: now.toISOString() }],
        receipt: input.receipt,
        lease_owner: input.lease_owner,
        lease_expires_at: new Date(now.getTime() + leaseTtl).toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
    } catch (err) {
      // drizzle-orm wraps the underlying pg error (code 23505) in a
      // DrizzleQueryError; unwrap the cause to read code/constraint.
      const cause = (err as { cause?: { code?: string; constraint?: string } })?.cause;
      const code = (cause ?? (err as { code?: string })).code;
      const constraint = (cause ?? (err as { constraint?: string })).constraint;
      if (code === "23505") {
        if (constraint === "payments_order_unique" && input.order_id) {
          throw new PaymentTargetConflictError("order", input.order_id);
        }
        if (constraint === "payments_gift_unique" && input.gift_id) {
          throw new PaymentTargetConflictError("gift", input.gift_id);
        }
      }
      throw err;
    }
  }

  async findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null> {
    // Filter in SQL (metadata->>'razorpay_payment_id') instead of scanning and
    // mapping every payment row on the webhook hot path.
    const result = await this.db.execute(sql`
      SELECT * FROM payments
       WHERE metadata->>'razorpay_payment_id' = ${razorpayPaymentId}
       LIMIT 1
    `);
    const row = toRows(result)[0];
    return row ? mapPaymentRow(row) : null;
  }

  async findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null> {
    const rows = toRows(
      await this.db
        .select()
        .from(payments)
        .where(eq(payments.provider_transaction_id, razorpayOrderId)),
    );
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  async getById(id: string): Promise<PaymentDTO | null> {
    const rows = toRows(await this.db.select().from(payments).where(eq(payments.id, id)));
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async getByGiftId(giftId: string): Promise<PaymentDTO | null> {
    const rows = toRows(await this.db.select().from(payments).where(eq(payments.gift_id, giftId)));
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  async getByOrderId(orderId: string): Promise<PaymentDTO | null> {
    const rows = toRows(await this.db.select().from(payments).where(eq(payments.order_id, orderId)));
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  async acquireLease(id: string, owner: string, ttlMs = 30_000): Promise<LeaseAcquireResult> {
    const result = await this.db.execute(sql`
      UPDATE payments
         SET lease_owner = ${owner},
             lease_expires_at = now() + make_interval(secs => ${ttlMs / 1000}),
             status = 'INITIATING',
             updated_at = now()
       WHERE id = ${id}
         AND provider_transaction_id IS NULL
         AND status IN ('INITIATING', 'FAILED_INITIATION')
         AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_expires_at IS NULL OR lease_expires_at <= now())
       RETURNING *
    `);
    const rows = toRows(result);
    if (rows[0]) {
      return { payment: mapPaymentRow(rows[0]), acquired: true, reason: "acquired" };
    }
    const existing = await this.getById(id);
    if (!existing) return { payment: null, acquired: false, reason: "not-found" };
    if (
      existing.razorpay_order_id !== null ||
      existing.status === "CREATED" ||
      existing.status === "AUTHORIZED" ||
      existing.status === "CAPTURED" ||
      existing.status === "REFUNDED"
    ) {
      return { payment: existing, acquired: false, reason: "settled" };
    }
    return { payment: existing, acquired: false, reason: "lease-held" };
  }

  async finalizeInitiation(
    id: string,
    providerTxnId: string,
    method?: string,
  ): Promise<PaymentDTO | null> {
    const attempts = attemptsAppend({
      event: "provider_order_created",
      at: new Date().toISOString(),
    });
    const metadataExpr = method
      ? sql`jsonb_set(${attempts}, '{method}', ${JSON.stringify(method)}::jsonb)`
      : attempts;
    const result = await this.db.execute(sql`
      UPDATE payments
         SET provider_transaction_id = ${providerTxnId},
             status = 'CREATED',
             lease_owner = NULL,
             lease_expires_at = NULL,
             metadata = ${metadataExpr},
             updated_at = now()
       WHERE id = ${id}
         AND provider_transaction_id IS NULL
         AND status = 'INITIATING'
       RETURNING *
    `);
    const rows = toRows(result);
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async markFailedInitiation(id: string, reason: string): Promise<PaymentDTO | null> {
    const result = await this.db.execute(sql`
      UPDATE payments
         SET status = 'FAILED_INITIATION',
             lease_owner = NULL,
             lease_expires_at = NULL,
             metadata = ${attemptsAppend({
               event: "initiation_failed",
               at: new Date().toISOString(),
               reason,
             })},
             updated_at = now()
       WHERE id = ${id}
         AND provider_transaction_id IS NULL
         AND status = 'INITIATING'
       RETURNING *
    `);
    const rows = toRows(result);
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async appendAttempt(
    id: string,
    attempt: Omit<PaymentAttempt, "seq" | "at">,
  ): Promise<PaymentDTO | null> {
    const result = await this.db.execute(sql`
      UPDATE payments
         SET metadata = ${attemptsAppend({
           ...attempt,
           at: new Date().toISOString(),
         })},
             updated_at = now()
       WHERE id = ${id}
       RETURNING *
    `);
    const rows = toRows(result);
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async updateWebhookResult(id: string, data: WebhookUpdate): Promise<WebhookUpdateResult> {
    const current = await this.getById(id);
    if (!current) return { payment: null, applied: false };
    if (PAYMENT_STATUS_RANK[data.status] <= PAYMENT_STATUS_RANK[current.status]) {
      return { payment: current, applied: false };
    }
    // Single atomic UPDATE guarded by a CAS on the status read above: if a
    // concurrent webhook advanced the row first, the WHERE clause matches
    // nothing and we re-read to honor the monotonic ladder.
    const result = await this.db.execute(sql`
      UPDATE payments
         SET status = ${data.status},
             metadata = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     ${attemptsAppend({
                       event: data.webhook_event,
                       at: new Date().toISOString(),
                       razorpay_payment_id: data.razorpay_payment_id,
                     })},
                     '{razorpay_payment_id}', ${JSON.stringify(data.razorpay_payment_id)}::jsonb
                   ),
                   '{method}', ${JSON.stringify(data.method)}::jsonb
                 ),
                 '{webhook_event}', ${JSON.stringify(data.webhook_event)}::jsonb
               ),
               '{webhook_raw}', ${JSON.stringify(data.webhook_raw ?? null)}::jsonb
             ),
             updated_at = now()
       WHERE id = ${id}
         AND provider_transaction_id IS NOT NULL
         AND status = ${current.status}
       RETURNING *
    `);
    const rows = toRows(result);
    if (rows[0]) return { payment: mapPaymentRow(rows[0]), applied: true };
    const after = await this.getById(id);
    if (after && PAYMENT_STATUS_RANK[data.status] > PAYMENT_STATUS_RANK[after.status]) {
      return { payment: after, applied: false };
    }
    return { payment: after, applied: false };
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
