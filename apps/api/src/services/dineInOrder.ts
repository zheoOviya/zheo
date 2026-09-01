import type {
  CreateDineInOrderInput,
  DineInTransactionPort,
  DineInTransactionRepos,
} from "../repositories/dineInContracts";
import type { DineInOrderDTO, DineInOrderWithItemsDTO } from "../repositories/dineInContracts";
import type { CatalogRepository } from "../repositories/catalogRepository";
import { AppError } from "../middleware/envelope";
import type { MutationOutcome } from "./dineInSession";
import { calculateOrderPricing, type OrderPricingDraft } from "./dineInOrderPricing";

// ============================================
// Dine-In Order service (Dine-In bounded context).
//
// D2.5D1 scaffold: public command signatures, operation-context inputs,
// and result/outcome type surfaces. D2.5D2 fills placeOrder with the
// frozen validation/read shell. D2.5D3 adds the server-authoritative
// order pricing draft. D2.5D4 adds transactional aggregate persistence
// (order + items). D2.5D5 completes the production success path with
// the same-transaction OPEN -> ACTIVE first-order activation (guard
// removed).
//
// Persistence coordination happens exclusively through the injected
// DineInTransactionPort — the service never constructs repositories,
// never touches a global DB, and never opens its own transactions.
// Authoritative menu/catalog reads use the existing accepted
// CatalogRepository (constructor-injected, same convention as the
// ordering/discovery/catering services). No transaction repo reader
// exists for menu items; the catalog is never mutated by placeOrder, so
// a committed-data read inside the tx is authoritative.
// ============================================

// ------------------------------------------------------------
// Place order — caller-selectable intent ONLY.
//
// Authoritative facts (restaurant_id, table_id, unit_price,
// item_subtotal, gst, total_amount) are structurally absent so a
// caller can never authoritatively price an order. Quantity bounds
// (1..50) and duplicate-line rules are D2 validation concerns, not
// type constraints. Duplicate menu-item lines are allowed by using an
// array (not a keyed map).
// ------------------------------------------------------------

export interface PlaceOrderLineInput {
  readonly menu_item_id: string;
  readonly quantity: number;
  // Customization INTENT only, for future explicit rejection with
  // CUSTOMIZATIONS_NOT_SUPPORTED (D2). Deliberately non-authoritative:
  // name-only, no pricing/delta fields. No customization pricing model
  // is introduced here.
  readonly customizations?: readonly { readonly name: string }[];
}

export interface PlaceOrderInput {
  readonly session_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
  readonly items: readonly PlaceOrderLineInput[];
}

// ------------------------------------------------------------
// placeOrder result surface. Carries the authoritative persisted
// order WITH its persisted line items (DineInOrderWithItemsDTO).
// No bill/payment data.
// ------------------------------------------------------------

export interface PlaceOrderResult {
  readonly order: DineInOrderWithItemsDTO;
}

// ------------------------------------------------------------
// D2 validated-line structure: authoritative facts ONLY, in original
// caller order and multiplicity (duplicate lines are NOT merged).
// Deliberately no item_subtotal/gst/total — pricing is D3.
// base_price is sourced from the authoritative catalog reader
// (MenuItemDTO.price); caller prices do not exist in the input type.
// ------------------------------------------------------------

export interface ValidatedPlaceOrderLine {
  readonly menu_item_id: string;
  readonly quantity: number;
  readonly item_name: string;
  readonly base_price: number;
  readonly restaurant_id: string;
}

// ------------------------------------------------------------
// Advance order — legal forward targets ONLY.
// PLACED -> PREPARING -> READY_TO_SERVE -> SERVED. No arbitrary
// string status mutation; CANCELLED is not a forward target.
// ------------------------------------------------------------

export const DINE_IN_ADVANCE_TARGETS = ["PREPARING", "READY_TO_SERVE", "SERVED"] as const;

export type DineInOrderAdvanceTarget = (typeof DINE_IN_ADVANCE_TARGETS)[number];

// ------------------------------------------------------------
// D6.3 legal forward transition matrix (classification only). The CAS write
// for each edge lands in D6.4/D6.5/D6.6; until then legal candidates stop at
// a checkpoint guard. Same-target is idempotent and handled separately.
// ------------------------------------------------------------

export const DINE_IN_ADVANCE_EDGES = [
  { from: "PLACED", to: "PREPARING", checkpoint: "D6.4" },
  { from: "PREPARING", to: "READY_TO_SERVE", checkpoint: "D6.5" },
  { from: "READY_TO_SERVE", to: "SERVED", checkpoint: "D6.6" },
] as const;

export interface AdvanceOrderInput {
  readonly order_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
  readonly target_status: DineInOrderAdvanceTarget;
}

export interface AdvanceOrderResult {
  readonly order: DineInOrderDTO;
}

// ------------------------------------------------------------
// Cancel order. Actor id is carried so a later D7 audit can persist
// first-writer cancellation fields. No cancellation reason: the frozen
// contract does not require one.
// ------------------------------------------------------------

export interface CancelOrderInput {
  readonly order_id: string;
  readonly caller_user_id: string;
  readonly correlation_id: string;
}

export interface CancelOrderResult {
  readonly order: DineInOrderDTO;
}

// ------------------------------------------------------------
// Semantic post-commit event intent ONLY (D2.5D1 placeholder, D9
// owns real payload schemas/envelopes). Mirrors the future order
// event inventory. Not an EventEnvelope: no event_id/timestamp/emit.
// ------------------------------------------------------------

export type DineInOrderEventFact =
  | { readonly kind: "DINE_IN_ORDER_PLACED"; readonly order_id: string }
  | { readonly kind: "DINE_IN_ORDER_PREPARING"; readonly order_id: string }
  | { readonly kind: "DINE_IN_ORDER_READY_TO_SERVE"; readonly order_id: string }
  | { readonly kind: "DINE_IN_ORDER_SERVED"; readonly order_id: string }
  | { readonly kind: "DINE_IN_ORDER_CANCELLED"; readonly order_id: string };

// ------------------------------------------------------------
// Service. Persistence is coordinated only via the tx port; the port
// is injected (fake-able in tests, wired with
// DrizzleDineInTransactionPort in production). Outcome semantics reuse
// the accepted C-session MutationOutcome (NEW_MUTATION vs
// IDEMPOTENT_NO_MUTATION); domain failures are thrown AppErrors.
// ------------------------------------------------------------

export class DineInOrderService {
  constructor(
    private readonly txPort: DineInTransactionPort,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  async placeOrder(
    input: PlaceOrderInput,
  ): Promise<MutationOutcome<PlaceOrderResult, DineInOrderEventFact>> {
    return this.txPort.runInTransaction(async (repos: DineInTransactionRepos) => {
      // 1. First authoritative persistence operation: lock the session row.
      const session = await repos.diningSessions.lockById(input.session_id);
      // 2. Missing session OR owner mismatch collapse to the same error —
      //    no identity leakage.
      if (session === null || session.owner_user_id !== input.caller_user_id) {
        throw new AppError("SESSION_NOT_FOUND", "Dine-in session not found", 404);
      }
      // 3. State gate: only OPEN/ACTIVE accept new orders.
      if (session.status !== "OPEN" && session.status !== "ACTIVE") {
        throw new AppError(
          "SESSION_CLOSED_FOR_ORDERING",
          "Session is not open for ordering",
          409,
        );
      }
      // 4. Empty order rejected before any catalog read.
      if (input.items.length === 0) {
        throw new AppError("EMPTY_ORDER", "At least one item is required", 400);
      }
      // 5-7. Structural per-line validation then authoritative catalog
      // reads, preserving caller line order and multiplicity.
      const lines: ValidatedPlaceOrderLine[] = [];
      for (const line of input.items) {
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 50) {
          throw new AppError("INVALID_QUANTITY", "Quantity must be an integer between 1 and 50", 400);
        }
        if (line.customizations !== undefined && line.customizations.length > 0) {
          throw new AppError("CUSTOMIZATIONS_NOT_SUPPORTED", "Customizations are not supported", 400);
        }
        const item = await this.catalogRepo.getMenuItemById(line.menu_item_id);
        if (item === null) {
          throw new AppError("ITEM_NOT_FOUND", "Menu item not found", 404);
        }
        if (item.restaurant_id !== session.restaurant_id) {
          throw new AppError(
            "ITEM_RESTAURANT_MISMATCH",
            "Menu item does not belong to this restaurant",
            400,
          );
        }
        lines.push({
          menu_item_id: item.id,
          quantity: line.quantity,
          item_name: item.name,
          base_price: item.price,
          restaurant_id: item.restaurant_id,
        });
      }
      // D3: server-authoritative order pricing draft from the validated
      // authoritative facts (no re-read, no caller pricing).
      const draft: OrderPricingDraft = calculateOrderPricing(lines);
      // D4: transactional aggregate persistence (order + items in ONE
      // repository create, executed on the same locked-session tx). Exact
      // persisted snapshots: menu_item_id/name/base_price/quantity/item_subtotal
      // from the authoritative draft; no caller pricing; no session write.
      const createInput: CreateDineInOrderInput = {
        session_id: session.id,
        restaurant_id: session.restaurant_id,
        placed_by: input.caller_user_id,
        total_amount: draft.total_amount,
        notes: null,
        items: draft.lines.map((line) => ({
          menu_item_id: line.menu_item_id,
          name: line.name,
          base_price: line.base_price,
          quantity: line.quantity,
          customizations: [],
          customization_total: 0,
          item_subtotal: line.item_subtotal,
        })),
      };
      const order = await repos.dineInOrders.create(createInput);
      const persistedOrder = (
        await repos.dineInOrders.getBySessionWithItems(order.session_id)
      ).find((candidate) => candidate.id === order.id);
      if (persistedOrder === undefined) {
        // Defensive invariant: the create just succeeded on this same
        // transaction, so the read-back MUST observe it. Not a caller-visible
        // lookup miss; map to the project's existing internal-error
        // convention (INTERNAL_ERROR 500), not a new public taxonomy.
        throw new AppError(
          "INTERNAL_ERROR",
          "created order not visible on read-back within transaction",
          500,
        );
      }
      const result: PlaceOrderResult = { order: persistedOrder };
      // D5: OPEN -> ACTIVE first-order activation, in the SAME transaction,
      // strictly after successful order persistence/read-back. ACTIVE
      // sessions remain ACTIVE — no redundant ACTIVE->ACTIVE write.
      if (session.status === "OPEN") {
        const transition = await repos.diningSessions.transitionStatus(
          session.id,
          "OPEN",
          "ACTIVE",
        );
        if (transition.kind !== "UPDATED") {
          // NOT_FOUND / STATE_MISMATCH: defensive invariant failure mapped to
          // the frozen INTERNAL_ERROR 500 convention (D4-R1 precedent). No
          // self-heal, no silent continuation, no standalone retry — the
          // callback rejects so order persistence cannot externally succeed
          // without activation (atomic failure semantics).
          throw new AppError(
            "INTERNAL_ERROR",
            "OPEN->ACTIVE session transition failed after order persistence",
            500,
          );
        }
      }
      // First real production success path: the persisted aggregate is
      // returned. Event facts stay empty — DineInOrderPlaced belongs to D9,
      // and SessionActivated is DEFERRED by the frozen event inventory.
      return {
        kind: "NEW_MUTATION",
        value: result,
        eventFacts: [],
      };
    });
  }

  async advanceOrder(
    input: AdvanceOrderInput,
  ): Promise<MutationOutcome<AdvanceOrderResult, DineInOrderEventFact>> {
    return this.txPort.runInTransaction(async (repos: DineInTransactionRepos) => {
      // D6.1 lock discipline: NON-LOCKING discovery -> session lock -> order
      // lock. Discovery exists only to derive session_id; the discovery DTO
      // is NOT authoritative for status/transition/served_at/final mutation.
      const discovered = await repos.dineInOrders.getById(input.order_id);
      if (discovered === null) {
        throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
      }
      // Mandatory lock order: session row first, then the order row.
      const session = await repos.diningSessions.lockById(discovered.session_id);
      const order = await repos.dineInOrders.lockById(input.order_id);
      // Locked consistency: the locked session must exist, the locked order
      // must exist, and they must belong together.
      if (session === null) {
        // Missing locked session after discovery: defensive invariant per
        // the frozen INTERNAL_ERROR convention (no new public taxonomy).
        throw new AppError("INTERNAL_ERROR", "locked session missing for order advance", 500);
      }
      if (order === null) {
        throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
      }
      if (order.session_id !== session.id) {
        throw new AppError(
          "INTERNAL_ERROR",
          "order does not belong to the locked session",
          500,
        );
      }
      // D6.2 session-state capability boundary. Non-monetary order
      // advancement may continue after bill freeze, so OPEN/ACTIVE/
      // BILL_REQUESTED/PAYMENT_PENDING all pass through to D6.3 evaluation.
      // CLOSED + advance semantics belong to D-PAY (not frozen here):
      // explicit checkpoint guard, no invented domain taxonomy, no payment
      // logic, no order transition.
      if (session.status === "CLOSED") {
        throw new AppError(
          "NOT_IMPLEMENTED",
          "advance after session CLOSED is deferred to D-PAY (D2.5D6.2 boundary)",
          501,
        );
      }
      // D6.3 transition classification. Authoritative state is the LOCKED
      // order status ONLY (discovery.status is never consulted). Same-target
      // is idempotent: return the locked DTO untouched, no CAS, no
      // timestamps. Legal forward edges stop at a checkpoint guard naming
      // the future CAS checkpoint. Everything else is an invalid jump.
      if (order.status === input.target_status) {
        return {
          kind: "IDEMPOTENT_NO_MUTATION",
          value: { order },
          eventFacts: [],
        };
      }
      const edge = DINE_IN_ADVANCE_EDGES.find(
        (candidate) =>
          candidate.from === order.status && candidate.to === input.target_status,
      );
      if (edge) {
        // Implemented CAS writes: D6.4 (PLACED->PREPARING) and D6.5
        // (PREPARING->READY_TO_SERVE) are plain no-metadata transitions.
        // Statuses come from the frozen edge matrix, so the expected/target
        // pair can never drift from classification.
        if (edge.checkpoint === "D6.4" || edge.checkpoint === "D6.5") {
          const transition = await repos.dineInOrders.transitionStatus(
            order.id,
            edge.from,
            edge.to,
          );
          if (transition.kind === "UPDATED") {
            // Authoritative persisted DTO straight from the CAS result.
            return {
              kind: "NEW_MUTATION",
              value: { order: transition.value },
              eventFacts: [],
            };
          }
          if (transition.kind === "NOT_FOUND") {
            throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
          }
          // STATE_MISMATCH: the accepted TransitionResult carries only
          // `current` — not a full DTO — so an idempotent convergence result
          // cannot be fabricated safely. Same-target was already resolved
          // from the locked order before this CAS. Defensive 409.
          throw new AppError(
            "INVALID_DINE_IN_TRANSITION",
            "Order status transition is not allowed",
            409,
          );
        }
        // D6.6 (READY_TO_SERVE -> SERVED) is the single audit-timestamp
        // edge. One server timestamp is generated for this mutation attempt
        // and persisted atomically with status=SERVED in the SAME conditional
        // UPDATE. First-writer semantics: a later SERVED->SERVED retry is
        // resolved by same-target idempotency above, so it never reaches
        // this CAS and never overwrites served_at. The frozen edge matrix
        // has no other legal edges, so this is the terminal branch.
        const servedAt = new Date().toISOString();
        const transition = await repos.dineInOrders.transitionStatus(
          order.id,
          edge.from,
          edge.to,
          { served_at: servedAt },
        );
        if (transition.kind === "UPDATED") {
          // Authoritative persisted DTO straight from the CAS result.
          return {
            kind: "NEW_MUTATION",
            value: { order: transition.value },
            eventFacts: [],
          };
        }
        if (transition.kind === "NOT_FOUND") {
          throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
        }
        // STATE_MISMATCH: same accepted D6.4/D6.5 behavior — defensive 409,
        // no DTO fabrication, no second read for convergence.
        throw new AppError(
          "INVALID_DINE_IN_TRANSITION",
          "Order status transition is not allowed",
          409,
        );
      }
      // CANCELLED can never advance; backward/skip jumps are all invalid.
      throw new AppError(
        "INVALID_DINE_IN_TRANSITION",
        "Order status transition is not allowed",
        409,
      );
    });
  }

  async cancelOrder(
    input: CancelOrderInput,
  ): Promise<MutationOutcome<CancelOrderResult, DineInOrderEventFact>> {
    return this.txPort.runInTransaction(async (repos: DineInTransactionRepos) => {
      // D7.1 lock discipline mirrors advanceOrder (D6.1): NON-LOCKING
      // discovery -> session lock -> order lock. Discovery exists only to
      // derive session_id; the discovery DTO is NOT authoritative for any
      // cancellation decision (D7.2 owns precedence).
      const discovered = await repos.dineInOrders.getById(input.order_id);
      if (discovered === null) {
        throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
      }
      // Mandatory lock order: session row first, then the order row.
      const session = await repos.diningSessions.lockById(discovered.session_id);
      const order = await repos.dineInOrders.lockById(input.order_id);
      // Locked consistency: the locked session must exist, the locked order
      // must exist, and they must belong together.
      if (session === null) {
        // Missing locked session after discovery: defensive invariant per
        // the frozen INTERNAL_ERROR convention (no new public taxonomy).
        throw new AppError("INTERNAL_ERROR", "locked session missing for order cancel", 500);
      }
      if (order === null) {
        throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
      }
      if (order.session_id !== session.id) {
        throw new AppError(
          "INTERNAL_ERROR",
          "order does not belong to the locked session",
          500,
        );
      }
      // D7.2 cancellation precedence classification. The LOCKED state is the
      // ONLY authority — discovery.status is never consulted. Pure
      // classification, no writes. Precedence is exact and frozen:
      //   1. already CANCELLED -> idempotent, even under a billed/closed
      //      session (no CAS, no metadata rewrite).
      //   2. READY_TO_SERVE / SERVED -> ORDER_NOT_CANCELLABLE 409. This wins
      //      over any bill-freeze classification.
      //   3. PLACED / PREPARING under a billed (BILL_REQUESTED,
      //      PAYMENT_PENDING) or CLOSED session -> BILL_FROZEN 409. No
      //      CLOSED-specific error is invented.
      //   4. PLACED / PREPARING under an OPEN / ACTIVE session -> the
      //      cancellation mutation candidate: the D7.3 CAS + D7.4 audit
      //      metadata below.
      if (order.status === "CANCELLED") {
        return {
          kind: "IDEMPOTENT_NO_MUTATION",
          value: { order },
          eventFacts: [],
        };
      }
      if (order.status === "READY_TO_SERVE" || order.status === "SERVED") {
        throw new AppError(
          "ORDER_NOT_CANCELLABLE",
          "Dine-in order cannot be cancelled at its current stage",
          409,
        );
      }
      if (
        session.status === "BILL_REQUESTED" ||
        session.status === "PAYMENT_PENDING" ||
        session.status === "CLOSED"
      ) {
        throw new AppError(
          "BILL_FROZEN",
          "Order cannot be cancelled while the session bill is frozen",
          409,
        );
      }
      // D7.3 cancellation CAS: PLACED/PREPARING -> CANCELLED. Only these two
      // source states can reach here (D7.2 already resolved CANCELLED/
      // READY_TO_SERVE/SERVED and the billed/closed sessions), so the locked
      // status IS the exact expected source for the repository transition —
      // the expected/target pair can never drift from the frozen
      // classification.
      //
      // D7.4 cancellation audit metadata: cancelled_at + cancelled_by are
      // persisted in the SAME conditional UPDATE as status -> CANCELLED (see
      // DrizzleDineInOrderRepository.transitionStatus). Exactly one server
      // timestamp is generated per new cancellation mutation, strictly after
      // all D7.2 precedence gates; an already-CANCELLED retry resolved above
      // never reaches here and never regenerates or rewrites audit fields.
      // The actor is the frozen caller authority already carried in
      // CancelOrderInput — no role lookup, no auth changes, no new
      // authorization semantics.
      const cancelledAt = new Date().toISOString();
      const transition = await repos.dineInOrders.transitionStatus(
        order.id,
        order.status,
        "CANCELLED",
        {
          cancelled_at: cancelledAt,
          cancelled_by: input.caller_user_id,
        },
      );
      if (transition.kind === "UPDATED") {
        // D8.1 final-cancel billable-order determination. Only an ACTIVE
        // session ever needs reopen consideration — OPEN needs none, and
        // billed/CLOSED sessions already blocked PLACED/PREPARING above (D7.2
        // BILL_FROZEN gate). The read happens AFTER the successful order
        // cancellation CAS, inside the SAME runInTransaction while the session
        // row is still locked, so the persisted list is authoritative
        // post-cancel state: the just-cancelled order is already CANCELLED in
        // that list, so the frozen "billable = status !== CANCELLED" definition
        // (no payment/served/monetary/item filtering) counts it correctly
        // without any exclusion.
        if (session.status === "ACTIVE") {
          const remaining = await repos.dineInOrders.getBySessionWithItems(session.id);
          const isFinalBillableOrderCancellation = remaining.every(
            (o) => o.status === "CANCELLED",
          );
          if (isFinalBillableOrderCancellation) {
            // D8.2: ACTIVE -> OPEN session compensation for the final
            // cancellation, inside the SAME runInTransaction. The session row
            // is already locked and ACTIVE was authoritative for the D7.2
            // cancellation classification, so a CAS failure is a defensive
            // invariant: the transaction callback rejects -> INTERNAL_ERROR
            // 500, keeping the order cancellation and the session reopen one
            // atomic unit at the service/transaction-contract level (real
            // PostgreSQL rollback proof stays D2.5I). No new metadata is
            // needed: the repository signature requires none for ACTIVE->OPEN.
            const reopen = await repos.diningSessions.transitionStatus(
              session.id,
              "ACTIVE",
              "OPEN",
            );
            if (reopen.kind === "NOT_FOUND" || reopen.kind === "STATE_MISMATCH") {
              throw new AppError(
                "INTERNAL_ERROR",
                "ACTIVE session reopen failed after final order cancellation",
                500,
              );
            }
          }
        }
        // Authoritative persisted DTO straight from the CAS result.
        return {
          kind: "NEW_MUTATION",
          value: { order: transition.value },
          eventFacts: [],
        };
      }
      if (transition.kind === "NOT_FOUND") {
        throw new AppError("ORDER_NOT_FOUND", "Dine-in order not found", 404);
      }
      // STATE_MISMATCH: the accepted TransitionResult carries only `current`
      // — not a full DTO — so an idempotent convergence result cannot be
      // fabricated safely. A CANCELLED retry is already resolved pre-CAS from
      // the locked order (D7.2 first branch); current=CANCELLED here is a
      // concurrent divergence and stays a defensive 409. No second read.
      throw new AppError(
        "INVALID_DINE_IN_TRANSITION",
        "Order status transition is not allowed",
        409,
      );
    });
  }
}
