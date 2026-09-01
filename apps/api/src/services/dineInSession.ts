import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  DiningSessionDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  SessionBillDTO,
  TableResolveDTO,
  TableResolveRepository,
} from "../repositories/dineInContracts";
import type { ServiceRequestStatus, ServiceRequestType } from "@snakzap/types";
import { AppError } from "../middleware/envelope";
import { logger } from "../lib/logger";
import { calculateBillDraft } from "./dineInBillArithmetic";
import {
  emitDineInEventFactsBestEffort,
  type DineInEventFactEmitter,
} from "./dineInEventEmitter";

// ============================================
// Dining Session service (Dine-In bounded context).
//
// D2.5C1 scaffold ONLY: public command signatures, operation-context
// inputs, and result/outcome type surfaces. NO business flow is
// implemented yet (openSession/requestBill bodies are explicit stubs).
//
// Persistence coordination happens exclusively through the injected
// DineInTransactionPort — the service never constructs repositories,
// never touches a global DB, and never opens its own transactions.
// ============================================

// ------------------------------------------------------------
// Operation context inputs.
// ------------------------------------------------------------

export interface OpenSessionInput {
  readonly caller_user_id: string;
  readonly table_token: string;
  readonly correlation_id: string;
}

export interface RequestBillInput {
  readonly session_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
}

// ------------------------------------------------------------
// createServiceRequest operation-context input. request_type is validated
// at the service boundary: BRING_BILL is rejected (billing flow owns it) and
// unknown values from an untrusted boundary are rejected defensively.
// ------------------------------------------------------------

// D2.5E1 public create allowlist. BRING_BILL is deliberately absent: generic
// creation of the bill artifact is forbidden — requestBill owns it.
export const PUBLIC_SERVICE_REQUEST_CREATE_TYPES = [
  "WATER",
  "EXTRA_PLATE",
  "CUTLERY",
  "TISSUE",
  "CLEAN_TABLE",
  "CALL_STAFF",
  "OTHER",
] as const;

export const OTHER_NOTE_MAX_LENGTH = 500;

export interface CreateServiceRequestInput {
  readonly session_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
  readonly request_type: ServiceRequestType;
  readonly note?: string | null;
}

export interface CreateServiceRequestResult {
  readonly request: ServiceRequestDTO;
}

// ------------------------------------------------------------
// D2.5E2 acknowledge operation-context input. Only request identity and the
// caller actor are accepted at this boundary — no staff assignment / role /
// zone fields are invented.
// ------------------------------------------------------------

export interface AcknowledgeServiceRequestInput {
  readonly request_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
}

export interface AcknowledgeServiceRequestResult {
  readonly request: ServiceRequestDTO;
}

// ------------------------------------------------------------
// D2.5E3 complete operation-context input. Only request identity and the
// caller actor are accepted at this boundary — no staff assignment / role /
// zone fields are invented.
// ------------------------------------------------------------

export interface CompleteServiceRequestInput {
  readonly request_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
}

export interface CompleteServiceRequestResult {
  readonly request: ServiceRequestDTO;
}

// ------------------------------------------------------------
// D2.5E4 cancel operation-context input. Only request identity and the caller
// actor are accepted at this boundary — no cancellation_reason / assignment /
// role / zone fields are invented.
// ------------------------------------------------------------

export interface CancelServiceRequestInput {
  readonly request_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
}

export interface CancelServiceRequestResult {
  readonly request: ServiceRequestDTO;
}

// ------------------------------------------------------------
// Service-level mutation outcome (D2.4I.2E semantics).
// NEW_MUTATION -> post-commit event candidates;
// IDEMPOTENT_NO_MUTATION -> zero event facts.
// Domain failures are thrown AppErrors, not returned values.
// ------------------------------------------------------------

export type MutationOutcome<T, E = never> =
  | {
      readonly kind: "NEW_MUTATION";
      readonly value: T;
      readonly eventFacts: E[];
    }
  | {
      readonly kind: "IDEMPOTENT_NO_MUTATION";
      readonly value: T;
      readonly eventFacts: readonly [];
    };

// ------------------------------------------------------------
// Semantic post-commit event intent ONLY. This is NOT an
// EventEnvelope: no event_id, no timestamp, no emit(), no Redis.
// Facts carry only the frozen payload facts (aggregate identity
// included for later envelope construction). No correlation_id
// inside the fact — the originating correlation id lives outside
// the transaction (C9 owns envelope handoff).
// ------------------------------------------------------------

export type DineInEventFact =
  | {
      readonly kind: "SESSION_OPENED";
      readonly session_id: string;
      readonly restaurant_id: string;
      readonly table_id: string;
      readonly customer_user_id: string;
    }
  | {
      readonly kind: "BILL_REQUESTED";
      readonly session_id: string;
      readonly bill_id: string;
      readonly restaurant_id: string;
      readonly table_id: string;
      readonly total_amount: number;
    }
  | {
      readonly kind: "SERVICE_REQUEST_CREATED";
      readonly request_id: string;
      readonly session_id: string;
      readonly restaurant_id: string;
      readonly request_type: ServiceRequestType;
      readonly request_status: ServiceRequestStatus;
    }
  | {
      readonly kind: "SERVICE_REQUEST_ACKNOWLEDGED";
      readonly request_id: string;
      readonly session_id: string;
      readonly restaurant_id: string;
      readonly request_type: ServiceRequestType;
      readonly request_status: ServiceRequestStatus;
    }
  | {
      readonly kind: "SERVICE_REQUEST_COMPLETED";
      readonly request_id: string;
      readonly session_id: string;
      readonly restaurant_id: string;
      readonly request_type: ServiceRequestType;
      readonly request_status: ServiceRequestStatus;
    }
  | {
      readonly kind: "SERVICE_REQUEST_CANCELLED";
      readonly request_id: string;
      readonly session_id: string;
      readonly restaurant_id: string;
      readonly request_type: ServiceRequestType;
      readonly request_status: ServiceRequestStatus;
    };

// ------------------------------------------------------------
// openSession result surface.
// CREATED  = a new session was inserted (maps to NEW_MUTATION).
// RESUMED  = same-owner existing live session (maps to
//            IDEMPOTENT_NO_MUTATION).
// ------------------------------------------------------------

export type OpenSessionResult =
  | { readonly kind: "CREATED"; readonly session: DiningSessionDTO }
  | { readonly kind: "RESUMED"; readonly session: DiningSessionDTO };

// ------------------------------------------------------------
// requestBill result surface. Carries the authoritative committed
// facts: the session, the frozen bill, and the BRING_BILL request
// artifact. bringBillRequest is null only for the PAYMENT_PENDING
// read-only repeat (that branch does NOT re-read/re-require the
// artifact per frozen contract). No payment state/data.
// ------------------------------------------------------------

export interface RequestBillResult {
  readonly session: DiningSessionDTO;
  readonly bill: SessionBillDTO;
  readonly bringBillRequest: ServiceRequestDTO | null;
}

// ------------------------------------------------------------
// Narrow Postgres unique-violation identification (D2.5C4).
// ONLY the live-session partial-unique index
// dining_sessions_live_table_idx (UNIQUE(table_id) WHERE status IN
// OPEN/ACTIVE/BILL_REQUESTED/PAYMENT_PENDING) may trigger the
// concurrent-open recovery. node-postgres surfaces it as
// err.code === "23505" with err.constraint === the index name;
// Drizzle's db.transaction propagates the driver error unchanged.
// Every other error fails closed and propagates — no broad DB-error
// framework, no global middleware changes.
// ------------------------------------------------------------

const LIVE_SESSION_UNIQUE_CONSTRAINT = "dining_sessions_live_table_idx";

function isLiveSessionUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === LIVE_SESSION_UNIQUE_CONSTRAINT;
}

// ------------------------------------------------------------
// Service. Persistence is coordinated only via the tx port; the
// port is injected (fake-able in tests, wired with
// DrizzleDineInTransactionPort in production later).
// ------------------------------------------------------------

export class DiningSessionService {
  constructor(
    private readonly txPort: DineInTransactionPort,
    // Post-commit best-effort emission. MUST NOT be called inside
    // runInTransaction — the service invokes it only after the transaction
    // has resolved successfully (D2.5C9.2). Failure to emit never changes
    // the committed domain result (helper never throws).
    private readonly emitFacts: DineInEventFactEmitter = emitDineInEventFactsBestEffort,
    // Read-only public table resolver (frozen UI1-A-R1/R2). Informational
    // only — NO transaction, NO lock, NO mutation, NO occupancy promise. The
    // authoritative open/resume decision remains POST /sessions. Optional so
    // existing constructions (routes/tests/harnesses) compile unchanged; the
    // resolve route wires it explicitly.
    private readonly tableResolveRepository?: TableResolveRepository,
  ) {}

  // Public read-only table resolve (frozen UI1-A-R1/R2/R3). Informational
  // only: no session create/resume, no transaction, no lock, no event
  // emission, no occupancy promise. Unknown / disabled table / inactive
  // restaurant all collapse to TABLE_NOT_FOUND 404 (the same collapsed
  // not-found representation as openSession). The opaque token is never part
  // of the returned DTO or the error.
  async resolveTable(token: string): Promise<TableResolveDTO> {
    if (!this.tableResolveRepository) {
      throw new AppError("INTERNAL_ERROR", "table resolve repository not configured", 500);
    }
    const normalized = token.trim();
    if (normalized === "") {
      throw new AppError("TABLE_NOT_FOUND", "Table not found", 404);
    }
    const resolved = await this.tableResolveRepository.resolveByToken(normalized);
    if (!resolved) {
      throw new AppError("TABLE_NOT_FOUND", "Table not found", 404);
    }
    return resolved;
  }

  async openSession(
    input: OpenSessionInput,
  ): Promise<MutationOutcome<OpenSessionResult, DineInEventFact>> {
    let outcome: MutationOutcome<OpenSessionResult, DineInEventFact>;
    try {
      outcome = await this.txPort.runInTransaction(async (repos) => {
        const { table, live } = await this.lockTableAndInspectLive(repos, input);
        const resolved = this.resolveLiveBranch(live, input.caller_user_id);
        if (resolved) return resolved;

        const session = await repos.diningSessions.create({
          restaurant_id: table.restaurant_id,
          table_id: table.id,
          owner_user_id: input.caller_user_id,
        });

        return {
          kind: "NEW_MUTATION",
          value: { kind: "CREATED", session },
          eventFacts: [
            {
              kind: "SESSION_OPENED",
              session_id: session.id,
              restaurant_id: table.restaurant_id,
              table_id: table.id,
              customer_user_id: input.caller_user_id,
            },
          ],
        };
      });
    } catch (err) {
      // Concurrent-open race recovery (D2.5C4). The first transaction already
      // aborted on the unique violation and rolled back completely — nothing
      // from it is queried again. Only the exact live-session constraint
      // triggers recovery; every other error propagates unchanged.
      if (!isLiveSessionUniqueViolation(err)) throw err;
      outcome = await this.recoverFromConcurrentOpen(input);
    }
    // Post-commit boundary: only a committed NEW_MUTATION with explicit
    // semantic facts may be emitted. Resume/repeat outcomes emit nothing.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      await this.emitFacts(outcome.eventFacts, input.correlation_id);
    }
    return outcome;
  }

  // Shared first-phase for BOTH the normal path and post-race recovery:
  // lock the table (first authoritative op), validate eligibility, then lock
  // the table's live session. Recovery re-runs this so no values from the
  // rolled-back transaction are ever reused. Which statuses count as "live"
  // is defined solely by the repository's lockLiveByTable semantics.
  private async lockTableAndInspectLive(
    repos: DineInTransactionRepos,
    input: OpenSessionInput,
  ): Promise<{ table: RestaurantTableDTO; live: DiningSessionDTO | null }> {
    const table = await repos.restaurantTables.lockByToken(input.table_token);
    if (!table || !table.is_active) {
      throw new AppError("TABLE_NOT_FOUND", "Table not found or disabled", 404);
    }

    const eligibility = await repos.restaurantEligibility.getEligibility(
      table.restaurant_id,
    );
    if (!eligibility || !eligibility.is_active) {
      throw new AppError("TABLE_NOT_FOUND", "Restaurant not eligible", 404);
    }

    const live = await repos.diningSessions.lockLiveByTable(table.id);
    return { table, live };
  }

  // Same-owner resume / different-owner occupied. Returns an outcome ONLY for
  // resume; occupied throws a static identity-safe conflict. No mutation.
  private resolveLiveBranch(
    live: DiningSessionDTO | null,
    callerUserId: string,
  ): MutationOutcome<OpenSessionResult, DineInEventFact> | null {
    if (!live) return null;
    if (live.owner_user_id === callerUserId) {
      return {
        kind: "IDEMPOTENT_NO_MUTATION",
        value: { kind: "RESUMED", session: live },
        eventFacts: [],
      };
    }
    throw new AppError("TABLE_OCCUPIED", "Table is currently occupied", 409);
  }

  // EXACTLY ONE fresh transaction after a recognized concurrent-open unique
  // violation. Re-locks the table, revalidates eligibility, inspects the
  // winner, and converges (same owner -> resume; different owner -> occupied).
  private async recoverFromConcurrentOpen(
    input: OpenSessionInput,
  ): Promise<MutationOutcome<OpenSessionResult, DineInEventFact>> {
    return this.txPort.runInTransaction(async (repos) => {
      const { live } = await this.lockTableAndInspectLive(repos, input);
      const resolved = this.resolveLiveBranch(live, input.caller_user_id);
      if (resolved) return resolved;

      // Recognized live-session unique violation yet the fresh transaction
      // sees no live session (the concurrent winner closed/vacated between
      // rollback and re-read). This is an invariant breach, NOT a second
      // creation opportunity: do not insert a third session attempt here.
      throw new AppError(
        "INTERNAL_ERROR",
        "concurrent-open race: no live session after unique violation",
        500,
      );
    });
  }

  async requestBill(
    input: RequestBillInput,
  ): Promise<MutationOutcome<RequestBillResult, DineInEventFact>> {
    const outcome: MutationOutcome<RequestBillResult, DineInEventFact> =
      await this.txPort.runInTransaction(async (repos) => {
      // First authoritative persistence operation: lock the session row.
      const session = await repos.diningSessions.lockById(input.session_id);
      if (!session) {
        throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
      }
      if (session.owner_user_id !== input.caller_user_id) {
        // Ownership failure collapses to the SAME public error as absence.
        // No owner identity, restaurant, or table detail is exposed.
        throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
      }

      switch (session.status) {
        case "OPEN":
          // Not billable in this state; no bill/request/transition writes.
          throw new AppError(
            "SESSION_NOT_BILLABLE",
            "Session is not billable in its current state",
            400,
          );

        case "ACTIVE": {
          const existing = await repos.sessionBills.getBySessionId(session.id);
          if (existing) {
            // An ACTIVE session must not already carry a frozen bill. No
            // self-heal; this is a server-side invariant breach.
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "ACTIVE session already has a frozen bill",
              500,
            );
          }
          // Authoritative bill input: listForBill returns the non-CANCELLED
          // order snapshot for this session; item_subtotal is already
          // normalized to number at the repository boundary. DineInOrder
          // .total_amount and current menu/base_price are NEVER used.
          const billableOrders = await repos.dineInOrders.listForBill(
            session.id,
          );
          const itemSubtotals = billableOrders.flatMap((order) =>
            order.items.map((item) => item.item_subtotal),
          );
          if (billableOrders.length === 0 || itemSubtotals.length === 0) {
            // Zero billable orders OR zero item snapshots: never create a
            // ₹0 bill. A legitimate zero-priced item still counts as a
            // billable snapshot; this invariant is about the ABSENCE of
            // billable orders/items. ACTIVE->OPEN compensation belongs only
            // to final-order cancellation, not here.
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "ACTIVE session has no billable items",
              500,
            );
          }
          const draft = calculateBillDraft(itemSubtotals);

          // ---- Atomic freeze (D2.5C7): all three writes share the SAME
          // runInTransaction callback, in frozen order bill -> session ->
          // request. If any step fails the callback throws and the whole
          // outer transaction rolls back. No nested transaction. No
          // independent retry of any mutation. ----

          const bill = await repos.sessionBills.createFrozenBill({
            session_id: session.id,
            restaurant_id: session.restaurant_id,
            food_subtotal: draft.food_subtotal,
            packaging_fee: draft.packaging_fee,
            gst_food: draft.gst_food,
            gst_packaging: draft.gst_packaging,
            total_amount: draft.total_amount,
          });

          const transition = await repos.diningSessions.transitionStatus(
            session.id,
            "ACTIVE",
            "BILL_REQUESTED",
            { bill_requested_at: new Date().toISOString() },
          );
          if (transition.kind !== "UPDATED") {
            // NOT_FOUND / STATE_MISMATCH: defensive invariant failure. No
            // self-heal, no silent continuation, no standalone retry — the
            // outer transaction aborts/rolls back.
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "ACTIVE->BILL_REQUESTED session transition failed",
              500,
            );
          }

          const bringBillRequest = await repos.serviceRequests.create({
            session_id: session.id,
            restaurant_id: session.restaurant_id,
            requested_by: input.caller_user_id,
            request_type: "BRING_BILL",
          });

          return {
            kind: "NEW_MUTATION",
            value: {
              // Authoritative committed results: the updated BILL_REQUESTED
              // session from the CAS, the persisted bill, and the persisted
              // BRING_BILL request. No stale ACTIVE snapshot.
              session: transition.value,
              bill,
              bringBillRequest,
            },
            eventFacts: [
              {
                kind: "BILL_REQUESTED",
                session_id: session.id,
                bill_id: bill.id,
                restaurant_id: session.restaurant_id,
                table_id: session.table_id,
                total_amount: bill.total_amount,
              },
              {
                kind: "SERVICE_REQUEST_CREATED",
                request_id: bringBillRequest.id,
                session_id: session.id,
                restaurant_id: session.restaurant_id,
                request_type: bringBillRequest.request_type,
                request_status: bringBillRequest.status,
              },
            ],
          };
        }

        case "BILL_REQUESTED": {
          const bill = await repos.sessionBills.getBySessionId(session.id);
          if (!bill) {
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "BILL_REQUESTED session has no frozen bill",
              500,
            );
          }
          const lookup = await repos.serviceRequests.findBringBillBySession(
            session.id,
          );
          // NONE and MULTIPLE both breach the exactly-one-artifact invariant.
          if (lookup.kind !== "FOUND") {
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "BILL_REQUESTED session must have exactly one BRING_BILL request",
              500,
            );
          }
          // Read-only repeat contract: no mutation, no event.
          return {
            kind: "IDEMPOTENT_NO_MUTATION",
            value: {
              session,
              bill,
              bringBillRequest: lookup.value,
            },
            eventFacts: [],
          };
        }

        case "PAYMENT_PENDING": {
          const bill = await repos.sessionBills.getBySessionId(session.id);
          if (!bill) {
            throw new AppError(
              "BILL_INVARIANT_VIOLATION",
              "PAYMENT_PENDING session has no frozen bill",
              500,
            );
          }
          // Read-only repeat contract: BRING_BILL is NOT re-read or required
          // here (payment details are D-PAY gated). No mutation, no event.
          return {
            kind: "IDEMPOTENT_NO_MUTATION",
            value: { session, bill, bringBillRequest: null },
            eventFacts: [],
          };
        }

        case "CLOSED":
          // Frozen closed/not-billable conflict behavior only. No invented
          // payment-close semantics, no self-heal, no transition.
          throw new AppError(
            "SESSION_NOT_BILLABLE",
            "Session is not billable in its current state",
            400,
          );

        default:
          throw new AppError(
            "INTERNAL_ERROR",
            "unknown dining session status",
            500,
          );
      }
    });

    // Post-commit boundary: requestBill's repeat branches (BILL_REQUESTED /
    // PAYMENT_PENDING) return IDEMPOTENT_NO_MUTATION with zero facts and emit
    // nothing. Only the committed first-freeze NEW_MUTATION (exactly two
    // facts) reaches emission. No emit happens inside the callback above.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      await this.emitFacts(outcome.eventFacts, input.correlation_id);
    }
    return outcome;
  }

  async createServiceRequest(
    input: CreateServiceRequestInput,
  ): Promise<MutationOutcome<CreateServiceRequestResult, DineInEventFact>> {
    const outcome = await this.txPort.runInTransaction<
      MutationOutcome<CreateServiceRequestResult, DineInEventFact>
    >(async (repos: DineInTransactionRepos) => {
        // 1. First authoritative persistence operation: lock the session row.
        const session = await repos.diningSessions.lockById(input.session_id);
        // 2. Missing session OR owner mismatch collapse to the same error —
        //    no identity leakage.
        if (session === null || session.owner_user_id !== input.caller_user_id) {
          throw new AppError("SESSION_NOT_FOUND", "Dine-in session not found", 404);
        }
        // 3. State gate: OPEN/ACTIVE/BILL_REQUESTED/PAYMENT_PENDING all accept
        //    service requests; a CLOSED session is frozen. No session mutation.
        if (session.status === "CLOSED") {
          throw new AppError(
            "SESSION_CLOSED_FOR_REQUEST",
            "Session is closed for service requests",
            409,
          );
        }
        // 4. Public create-type allowlist. BRING_BILL is managed exclusively by
        //    the billing flow (requestBill) and is never creatable here. An
        //    unknown value from an untrusted boundary is rejected defensively.
        if (input.request_type === "BRING_BILL") {
          throw new AppError(
            "BRING_BILL_MANAGED_BY_BILL_FLOW",
            "Bringing the bill is managed by the billing flow",
            409,
          );
        }
        if (!PUBLIC_SERVICE_REQUEST_CREATE_TYPES.includes(input.request_type)) {
          throw new AppError("INVALID_REQUEST_TYPE", "Unknown service request type", 400);
        }
        // 5. OTHER note rule: trim, require non-empty, cap at OTHER_NOTE_MAX_LENGTH.
        //    The trimmed note is persisted. For non-OTHER types no note
        //    requirement is invented — the value is passed through untouched.
        let note = input.note ?? null;
        if (input.request_type === "OTHER") {
          const trimmed = (input.note ?? "").trim();
          if (trimmed.length === 0) {
            throw new AppError("OTHER_NOTE_REQUIRED", "An OTHER request requires a note", 400);
          }
          if (trimmed.length > OTHER_NOTE_MAX_LENGTH) {
            // Reuse the accepted generic 400 validation convention (already used
            // for range/format validation at the service layer) — no new public
            // taxonomy is invented for this boundary.
            throw new AppError(
              "VALIDATION_ERROR",
              `OTHER note must not exceed ${OTHER_NOTE_MAX_LENGTH} characters`,
              400,
            );
          }
          note = trimmed;
        }
        // 6. Persist exactly one PENDING request in the same transaction and
        //    return the authoritative created DTO. No session/bill/payment/
        //    assignment writes. The committed create yields exactly one
        //    SERVICE_REQUEST_CREATED fact (D2.5G1); emission is post-commit.
        const request = await repos.serviceRequests.create({
          session_id: session.id,
          restaurant_id: session.restaurant_id,
          requested_by: input.caller_user_id,
          request_type: input.request_type,
          note,
        });
        return {
          kind: "NEW_MUTATION",
          value: { request },
          eventFacts: [
            {
              kind: "SERVICE_REQUEST_CREATED",
              request_id: request.id,
              session_id: session.id,
              restaurant_id: session.restaurant_id,
              request_type: request.request_type,
              request_status: request.status,
            },
          ],
        };
      },
    );

    // Post-commit boundary: emit only for the committed NEW_MUTATION, never
    // inside the transaction callback. Best-effort — an emission failure must
    // NOT fail the already committed create (frozen C9.2 isolation rule):
    // the committed operation still returns success. Log identity fields only.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      try {
        await this.emitFacts(outcome.eventFacts, input.correlation_id);
      } catch (err) {
        logger.error({
          message: "dinein_create_request_emit_failed",
          correlation_id: input.correlation_id,
          request_id:
            outcome.kind === "NEW_MUTATION" && outcome.value.request
              ? outcome.value.request.id
              : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  }

  // ------------------------------------------------------------
  // D2.5E2 acknowledgeServiceRequest. Authoritative locked-state semantics:
  // non-locking request discovery -> session lock -> request lock ->
  // relationship revalidation. Canonical lock order is session then request.
  // ------------------------------------------------------------
  async acknowledgeServiceRequest(
    input: AcknowledgeServiceRequestInput,
  ): Promise<MutationOutcome<AcknowledgeServiceRequestResult, DineInEventFact>> {
    const outcome = await this.txPort.runInTransaction<
      MutationOutcome<AcknowledgeServiceRequestResult, DineInEventFact>
    >(async (repos: DineInTransactionRepos) => {
      // 1. Non-locking discovery: the request row identifies its owning session
      //    before any row is locked. Missing request -> 404.
      const discovered = await repos.serviceRequests.getById(input.request_id);
      if (discovered === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // 2. Canonical lock order: session row first, then the request row.
      const session = await repos.diningSessions.lockById(discovered.session_id);
      const request = await repos.serviceRequests.lockById(input.request_id);
      // 3. Relationship revalidation against the LOCKED rows. A missing locked
      //    session or a session mismatch is a defensive internal failure (the
      //    discovered row already proved the request exists); a missing locked
      //    request maps to the public 404.
      if (session === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Locked session missing while acknowledging service request",
          500,
        );
      }
      if (request === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      if (request.session_id !== session.id) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Service request does not belong to the locked session",
          500,
        );
      }
      // 4. Classification from the LOCKED status only:
      //    ACKNOWLEDGED -> idempotent retry (pre-CAS exit, no mutation, no
      //    audit rewrite); COMPLETED/CANCELLED -> terminal, 409. The only
      //    remaining status is PENDING, which is the CAS source below.
      if (request.status === "ACKNOWLEDGED") {
        return {
          kind: "IDEMPOTENT_NO_MUTATION",
          value: { request },
          eventFacts: [],
        };
      }
      if (request.status === "COMPLETED" || request.status === "CANCELLED") {
        throw new AppError(
          "INVALID_SERVICE_REQUEST_TRANSITION",
          "Service request cannot be acknowledged in its current status",
          409,
        );
      }
      // 5. One server timestamp; status + acknowledged_at + acknowledged_by
      //    are written by the repository in the SAME conditional update
      //    (source PENDING -> target ACKNOWLEDGED). No convergence second read.
      const acknowledgedAt = new Date().toISOString();
      const transition = await repos.serviceRequests.acknowledge(
        request.id,
        input.caller_user_id,
        acknowledgedAt,
      );
      if (transition.kind === "UPDATED") {
        // The committed transition yields exactly one SERVICE_REQUEST_ACKNOWLEDGED
        // fact, derived from the authoritative transition DTO (D2.5G2).
        return {
          kind: "NEW_MUTATION",
          value: { request: transition.value },
          eventFacts: [
            {
              kind: "SERVICE_REQUEST_ACKNOWLEDGED",
              request_id: transition.value.id,
              session_id: transition.value.session_id,
              restaurant_id: transition.value.restaurant_id,
              request_type: transition.value.request_type,
              request_status: transition.value.status,
            },
          ],
        };
      }
      if (transition.kind === "NOT_FOUND") {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // STATE_MISMATCH: the locked row said PENDING but the conditional update
      // saw a different current — concurrent divergence, defensive 409.
      throw new AppError(
        "INVALID_SERVICE_REQUEST_TRANSITION",
        "Service request status transition is not allowed",
        409,
      );
    });

    // Post-commit boundary: emit only for the committed NEW_MUTATION, never
    // inside the transaction callback. Best-effort — an emission failure must
    // NOT fail the already committed acknowledge (frozen C9.2 isolation rule).
    // An ACKNOWLEDGED idempotent retry returns zero facts and emits nothing.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      try {
        await this.emitFacts(outcome.eventFacts, input.correlation_id);
      } catch (err) {
        logger.error({
          message: "dinein_acknowledge_request_emit_failed",
          correlation_id: input.correlation_id,
          request_id:
            outcome.kind === "NEW_MUTATION" && outcome.value.request
              ? outcome.value.request.id
              : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  }

  // ------------------------------------------------------------
  // D2.5E3 completeServiceRequest. Authoritative locked-state semantics:
  // non-locking request discovery -> session lock -> request lock ->
  // relationship revalidation. Canonical lock order is session then request.
  // The ONLY source is ACKNOWLEDGED; PENDING is never silently auto-acknowledged.
  // ------------------------------------------------------------
  async completeServiceRequest(
    input: CompleteServiceRequestInput,
  ): Promise<MutationOutcome<CompleteServiceRequestResult, DineInEventFact>> {
    const outcome = await this.txPort.runInTransaction<
      MutationOutcome<CompleteServiceRequestResult, DineInEventFact>
    >(async (repos: DineInTransactionRepos) => {
      // 1. Non-locking discovery: the request row identifies its owning session
      //    before any row is locked. Missing request -> 404.
      const discovered = await repos.serviceRequests.getById(input.request_id);
      if (discovered === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // 2. Canonical lock order: session row first, then the request row.
      const session = await repos.diningSessions.lockById(discovered.session_id);
      const request = await repos.serviceRequests.lockById(input.request_id);
      // 3. Relationship revalidation against the LOCKED rows. A missing locked
      //    session or a session mismatch is a defensive internal failure (the
      //    discovered row already proved the request exists); a missing locked
      //    request maps to the public 404.
      if (session === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Locked session missing while completing service request",
          500,
        );
      }
      if (request === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      if (request.session_id !== session.id) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Service request does not belong to the locked session",
          500,
        );
      }
      // 4. Classification from the LOCKED status only:
      //    COMPLETED -> idempotent retry (pre-CAS exit, no mutation, no audit
      //    rewrite); PENDING and CANCELLED -> 409 (PENDING is NEVER silently
      //    auto-acknowledged). The only remaining status is ACKNOWLEDGED, which
      //    is the CAS source below.
      if (request.status === "COMPLETED") {
        return {
          kind: "IDEMPOTENT_NO_MUTATION",
          value: { request },
          eventFacts: [],
        };
      }
      if (request.status === "PENDING" || request.status === "CANCELLED") {
        throw new AppError(
          "INVALID_SERVICE_REQUEST_TRANSITION",
          "Service request cannot be completed in its current status",
          409,
        );
      }
      // 5. One server timestamp; status + completed_at + completed_by are
      //    written by the repository in the SAME conditional update
      //    (source ACKNOWLEDGED -> target COMPLETED). No convergence second read.
      const completedAt = new Date().toISOString();
      const transition = await repos.serviceRequests.complete(
        request.id,
        input.caller_user_id,
        completedAt,
      );
      if (transition.kind === "UPDATED") {
        // The committed transition yields exactly one SERVICE_REQUEST_COMPLETED
        // fact, derived from the authoritative transition DTO (D2.5G3).
        return {
          kind: "NEW_MUTATION",
          value: { request: transition.value },
          eventFacts: [
            {
              kind: "SERVICE_REQUEST_COMPLETED",
              request_id: transition.value.id,
              session_id: transition.value.session_id,
              restaurant_id: transition.value.restaurant_id,
              request_type: transition.value.request_type,
              request_status: transition.value.status,
            },
          ],
        };
      }
      if (transition.kind === "NOT_FOUND") {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // STATE_MISMATCH: the locked row said ACKNOWLEDGED but the conditional
      // update saw a different current — concurrent divergence, defensive 409.
      throw new AppError(
        "INVALID_SERVICE_REQUEST_TRANSITION",
        "Service request status transition is not allowed",
        409,
      );
    });

    // Post-commit boundary: emit only for the committed NEW_MUTATION, never
    // inside the transaction callback. Best-effort — an emission failure must
    // NOT fail the already committed completion (frozen C9.2 isolation rule).
    // A COMPLETED idempotent retry returns zero facts and emits nothing.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      try {
        await this.emitFacts(outcome.eventFacts, input.correlation_id);
      } catch (err) {
        logger.error({
          message: "dinein_complete_request_emit_failed",
          correlation_id: input.correlation_id,
          request_id:
            outcome.kind === "NEW_MUTATION" && outcome.value.request
              ? outcome.value.request.id
              : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  }

  // ------------------------------------------------------------
  // D2.5E4 cancelServiceRequest. Authoritative locked-state semantics:
  // non-locking request discovery -> session lock -> request lock ->
  // relationship revalidation. Canonical lock order is session then request.
  // Cancellation precedence on the locked request:
  //   1. BRING_BILL special boundary (409, wins over every state)
  //   2. CANCELLED idempotent retry
  //   3. COMPLETED invalid (409)
  //   4. PENDING / ACKNOWLEDGED cancellable via CAS
  // ------------------------------------------------------------
  async cancelServiceRequest(
    input: CancelServiceRequestInput,
  ): Promise<MutationOutcome<CancelServiceRequestResult, DineInEventFact>> {
    const outcome = await this.txPort.runInTransaction<
      MutationOutcome<CancelServiceRequestResult, DineInEventFact>
    >(async (repos: DineInTransactionRepos) => {
      // 1. Non-locking discovery: the request row identifies its owning session
      //    before any row is locked. Missing request -> 404.
      const discovered = await repos.serviceRequests.getById(input.request_id);
      if (discovered === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // 2. Canonical lock order: session row first, then the request row.
      const session = await repos.diningSessions.lockById(discovered.session_id);
      const request = await repos.serviceRequests.lockById(input.request_id);
      // 3. Relationship revalidation against the LOCKED rows. A missing locked
      //    session or a session mismatch is a defensive internal failure (the
      //    discovered row already proved the request exists); a missing locked
      //    request maps to the public 404.
      if (session === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Locked session missing while cancelling service request",
          500,
        );
      }
      if (request === null) {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      if (request.session_id !== session.id) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Service request does not belong to the locked session",
          500,
        );
      }
      // 4. BRING_BILL special boundary wins over every lifecycle state,
      //    including an already-CANCELLED BRING_BILL. The billing flow owns
      //    the bill artifact; generic cancellation never touches it.
      if (request.request_type === "BRING_BILL") {
        throw new AppError(
          "BRING_BILL_MANAGED_BY_BILL_FLOW",
          "Bringing the bill is managed by the billing flow",
          409,
        );
      }
      // 5. Classification from the LOCKED status only:
      //    CANCELLED -> idempotent retry (pre-CAS exit, no mutation, no audit
      //    rewrite); COMPLETED -> terminal, 409. PENDING / ACKNOWLEDGED fall
      //    through to the cancellation CAS below.
      if (request.status === "CANCELLED") {
        return {
          kind: "IDEMPOTENT_NO_MUTATION",
          value: { request },
          eventFacts: [],
        };
      }
      if (request.status === "COMPLETED") {
        throw new AppError(
          "INVALID_SERVICE_REQUEST_TRANSITION",
          "Service request cannot be cancelled in its current status",
          409,
        );
      }
      // 6. One server timestamp; status + cancelled_at + cancelled_by are
      //    written by the repository in the SAME conditional update
      //    (source PENDING|ACKNOWLEDGED -> target CANCELLED). No convergence
      //    second read.
      const cancelledAt = new Date().toISOString();
      const transition = await repos.serviceRequests.cancel(
        request.id,
        input.caller_user_id,
        cancelledAt,
      );
      if (transition.kind === "UPDATED") {
        // The committed transition yields exactly one SERVICE_REQUEST_CANCELLED
        // fact, derived from the authoritative transition DTO (D2.5G4). The
        // BRING_BILL boundary above guarantees this fact never carries a
        // BRING_BILL request.
        return {
          kind: "NEW_MUTATION",
          value: { request: transition.value },
          eventFacts: [
            {
              kind: "SERVICE_REQUEST_CANCELLED",
              request_id: transition.value.id,
              session_id: transition.value.session_id,
              restaurant_id: transition.value.restaurant_id,
              request_type: transition.value.request_type,
              request_status: transition.value.status,
            },
          ],
        };
      }
      if (transition.kind === "NOT_FOUND") {
        throw new AppError("SERVICE_REQUEST_NOT_FOUND", "Service request not found", 404);
      }
      // STATE_MISMATCH: the locked row said PENDING/ACKNOWLEDGED but the
      // conditional update saw a different current — concurrent divergence,
      // defensive 409.
      throw new AppError(
        "INVALID_SERVICE_REQUEST_TRANSITION",
        "Service request status transition is not allowed",
        409,
      );
    });

    // Post-commit boundary: emit only for the committed NEW_MUTATION, never
    // inside the transaction callback. Best-effort — an emission failure must
    // NOT fail the already committed cancellation (frozen C9.2 isolation rule).
    // A CANCELLED idempotent retry returns zero facts and emits nothing; the
    // BRING_BILL 409 boundary throws before this point and emits nothing.
    if (outcome.kind === "NEW_MUTATION" && outcome.eventFacts.length > 0) {
      try {
        await this.emitFacts(outcome.eventFacts, input.correlation_id);
      } catch (err) {
        logger.error({
          message: "dinein_cancel_request_emit_failed",
          correlation_id: input.correlation_id,
          request_id:
            outcome.kind === "NEW_MUTATION" && outcome.value.request
              ? outcome.value.request.id
              : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  }
}
