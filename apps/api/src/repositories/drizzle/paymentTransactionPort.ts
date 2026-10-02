import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryPaymentTransactionPort,
  type PaymentTransactionPort,
  type PaymentTxRepos,
} from "../paymentAtomicityContracts";
import { getStorageMode } from "../shared";
import { memoryEventOutbox } from "../memoryEventOutbox";
import type { PaymentRepository } from "../paymentRepository";
import type { OrderRepository } from "../orderRepository";
import type { GiftRepository } from "../giftRepository";
import { DrizzlePaymentRepository } from "./drizzlePaymentRepository";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzleGiftRepository } from "./drizzleGiftRepository";
import { DrizzleEventOutboxRepository } from "./drizzleEventOutboxRepository";

// ============================================
// Drizzle transaction port for the ordinary/local payment producers
// (EVT-B2B-PAY-A).
//
// buildPaymentTxRepos constructs every repository — payments, orders, gifts and
// the outbox — from the SAME transaction handle, so a producer's business write
// and its event row share one commit boundary: a committed producer persists
// exactly one logical event row, and a rollback/CAS miss persists none.
//
// Runtime selection takes the producer's own repositories so memory/test mode
// passthrough observes the exact route-visible stores; Postgres mode ignores the
// arguments and builds per-transaction repositories from the tx handle. getDb()
// is only reachable on the explicit postgres branch, so memory/test mode never
// constructs a Postgres client or falls back from a Postgres failure.
// ============================================

export function buildPaymentTxRepos(tx: DrizzleDb): PaymentTxRepos {
  return {
    payments: new DrizzlePaymentRepository(tx),
    orders: new DrizzleOrderRepository(tx),
    gifts: new DrizzleGiftRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzlePaymentTransactionPort implements PaymentTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildPaymentTxRepos(tx)));
  }
}

let _paymentPort: PaymentTransactionPort | null = null;

export function getPaymentTransactionPort(
  paymentRepo: PaymentRepository,
  orderRepo: OrderRepository,
  giftRepo: GiftRepository,
): PaymentTransactionPort {
  if (getStorageMode() === "postgres") {
    _paymentPort ??= new DrizzlePaymentTransactionPort(getDb());
    return _paymentPort;
  }
  return new MemoryPaymentTransactionPort(() => ({
    payments: paymentRepo,
    orders: orderRepo,
    gifts: giftRepo,
    outbox: memoryEventOutbox,
  }));
}
