import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import {
  getDineInTableResolveRepository,
  getDineInTransactionPort,
} from "../repositories/dineInComposition";
import { DiningSessionService, PUBLIC_SERVICE_REQUEST_CREATE_TYPES } from "../services/dineInSession";
import {
  DineInOrderService,
  DINE_IN_ADVANCE_TARGETS,
} from "../services/dineInOrder";
import { getCatalogRepository } from "./catalog";

// ============================================
// Dine-In context routes - /api/v1/dine-in.
//
// Session routes (H2.2):
//   GET  /tables/resolve            -> resolveTable (PUBLIC, no authenticate)
//   POST /sessions                  -> openSession
//   POST /sessions/:sessionId/bill  -> requestBill
//
// Order routes (H3):
//   POST /orders                    -> placeOrder
//   POST /orders/:orderId/advance   -> advanceOrder
//   POST /orders/:orderId/cancel    -> cancelOrder
//
// Service-request routes (H4):
//   POST /service-requests                     -> createServiceRequest
//   POST /service-requests/:requestId/acknowledge -> acknowledgeServiceRequest
//   POST /service-requests/:requestId/complete    -> completeServiceRequest
//   POST /service-requests/:requestId/cancel      -> cancelServiceRequest
//
// The generic create transport deliberately excludes BRING_BILL: that request
// type is owned by the billing flow (requestBill) and is unreachable through
// this route (transport VALIDATION_ERROR 400). Acknowledge/complete/cancel are
// server-authoritative: no body state or audit fields are ever read from the
// client; server timestamps and caller identity come from locals only.
//
// Auth: caller_user_id from the existing `authenticate` middleware
// (res.locals.userId). correlation_id comes from res.locals.correlationId
// (correlation middleware). Neither is ever read from the client body/query.
//
// Server-authoritative pricing: no price/GST/total/packaging/commission or
// payment field is ever read from the client for orders. The catalog and the
// service own all pricing; item_subtotal/GST/total_amount are computed from
// persisted snapshots, never forwarded from the request body.
//
// H2.1 runtime composition: ONE shared Dine-In transaction port is used for
// both services — never a fresh memory repo universe per request.
// ============================================

// Transport validation only. Domain eligibility / pricing / ownership rules
// belong to the service, never duplicated here.
const OpenSessionSchema = z.object({
  table_token: z.string().min(1),
});

// Public table-resolution query (frozen UI1-A-R4). Transport only: a non-empty
// token string. The service owns trim/collapse semantics (unknown/disabled/
// inactive -> TABLE_NOT_FOUND 404). Missing or empty token fails here with
// VALIDATION_ERROR 400 before any service call.
const TableResolveQuerySchema = z.object({
  token: z.string().min(1),
});

// sessionId path segment must be a UUID at the transport boundary.
const SessionIdSchema = z.string().uuid();

// Place order transport. items intentionally has NO .min(1): an empty array
// passes transport so the service-owned EMPTY_ORDER (400) stays observable.
// customizations is allowed through (name-only intent) so the service can
// reject it with CUSTOMIZATIONS_NOT_SUPPORTED (400) — never silently dropped.
const OrderLineSchema = z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(50),
  customizations: z.array(z.object({ name: z.string().min(1) })).optional(),
});

const PlaceOrderSchema = z.object({
  session_id: z.string().uuid(),
  items: z.array(OrderLineSchema),
});

// Advance target limited to the accepted forward-target set.
const AdvanceOrderSchema = z.object({
  target_status: z.enum(DINE_IN_ADVANCE_TARGETS),
});

const OrderIdSchema = z.string().uuid();

// ------------------------------------------------------------
// Service-request transport schemas (H4).
//
// request_type is limited to PUBLIC_SERVICE_REQUEST_CREATE_TYPES. BRING_BILL
// is deliberately NOT in that set, so a client cannot reach the billing-owned
// request through the generic create route (transport VALIDATION_ERROR 400).
//
// note is typed string|null but otherwise left uncapped here: the OTHER
// required/trim/500-char rules are service-owned and stay canonical in
// createServiceRequest. The transport only guarantees a string-or-null shape.
// ------------------------------------------------------------
const ServiceRequestTypeSchema = z.enum(PUBLIC_SERVICE_REQUEST_CREATE_TYPES);

const CreateServiceRequestSchema = z.object({
  session_id: z.string().uuid(),
  request_type: ServiceRequestTypeSchema,
  note: z.string().nullable().optional(),
});

// requestId path segment must be a UUID at the transport boundary.
const RequestIdSchema = z.string().uuid();

const dineInSessionService = new DiningSessionService(
  getDineInTransactionPort(),
  undefined,
  getDineInTableResolveRepository(),
);

const dineInOrderService = new DineInOrderService(
  getDineInTransactionPort(),
  getCatalogRepository(),
);

export const dineInRouter: Router = Router();

// Public read-only table resolution (frozen UI1-A-R1..R4). Deliberately NO
// authenticate: the opaque QR token is the consumer's only credential at this
// step. Informational only — the authoritative open/resume decision remains
// POST /sessions (authenticated, locked transaction). Errors are service-owned
// (TABLE_NOT_FOUND 404 passthrough); no new taxonomy.
dineInRouter.get(
  "/tables/resolve",
  asyncHandler(async (req, res) => {
    const query = TableResolveQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid table resolve query",
        400,
        query.error.flatten(),
      );
    }

    const dto = await dineInSessionService.resolveTable(query.data.token);
    ok(res, dto);
  }),
);

dineInRouter.post(
  "/sessions",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = OpenSessionSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid open session request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const outcome = await dineInSessionService.openSession({
      caller_user_id: userId,
      table_token: body.data.table_token,
      correlation_id: res.locals.correlationId,
    });

    // CREATED and RESUMED both return 200 { session } (frozen H1 contract).
    ok(res, { session: outcome.value.session });
  }),
);

dineInRouter.post(
  "/sessions/:sessionId/bill",
  authenticate,
  asyncHandler(async (req, res) => {
    const sessionId = SessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid session id",
        400,
        sessionId.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // Server-authoritative: req.body is intentionally never read. The bill is
    // computed entirely from persisted order snapshots in the service.
    const outcome = await dineInSessionService.requestBill({
      session_id: sessionId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
    });

    // PAYMENT_PENDING repeat contract: bringBillRequest is null by design.
    ok(res, {
      session: outcome.value.session,
      bill: outcome.value.bill,
      bringBillRequest: outcome.value.bringBillRequest,
    });
  }),
);

// ------------------------------------------------------------
// Order routes (H3).
// ------------------------------------------------------------

dineInRouter.post(
  "/orders",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = PlaceOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid place order request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const outcome = await dineInOrderService.placeOrder({
      session_id: body.data.session_id,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
      items: body.data.items,
    });

    ok(res, { order: outcome.value.order }, 201);
  }),
);

dineInRouter.post(
  "/orders/:orderId/advance",
  authenticate,
  asyncHandler(async (req, res) => {
    const orderId = OrderIdSchema.safeParse(req.params.orderId);
    if (!orderId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid order id",
        400,
        orderId.error.flatten(),
      );
    }

    const body = AdvanceOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid advance request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // target_status limited to the frozen advance targets; no served_at is
    // accepted from the client.
    const outcome = await dineInOrderService.advanceOrder({
      order_id: orderId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
      target_status: body.data.target_status,
    });

    ok(res, { order: outcome.value.order });
  }),
);

dineInRouter.post(
  "/orders/:orderId/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const orderId = OrderIdSchema.safeParse(req.params.orderId);
    if (!orderId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid order id",
        400,
        orderId.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // No body is read: cancellation audit metadata (cancelled_at/cancelled_by)
    // is server-authoritative and cannot be client supplied.
    const outcome = await dineInOrderService.cancelOrder({
      order_id: orderId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
    });

    ok(res, { order: outcome.value.order });
  }),
);

// ------------------------------------------------------------
// Service-request routes (H4).
//
// All four share the same module-level DiningSessionService instance and the
// shared Dine-In transaction port — never a per-request service/repo universe.
//
// Auth/correlation only from locals. Acknowledge/complete/cancel never read
// req.body: status transitions and audit fields (acknowledged_by/at,
// completed_by/at, cancelled_by/at) are server-authoritative.
// ------------------------------------------------------------

dineInRouter.post(
  "/service-requests",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateServiceRequestSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid create service request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // note is passed through as-is; the service owns OTHER required/trim/500
    // validation. BRING_BILL is unreachable here (transport enum excludes it).
    const outcome = await dineInSessionService.createServiceRequest({
      session_id: body.data.session_id,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
      request_type: body.data.request_type,
      note: body.data.note,
    });

    ok(res, { request: outcome.value.request }, 201);
  }),
);

dineInRouter.post(
  "/service-requests/:requestId/acknowledge",
  authenticate,
  asyncHandler(async (req, res) => {
    const requestId = RequestIdSchema.safeParse(req.params.requestId);
    if (!requestId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid request id",
        400,
        requestId.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // No body is read: server timestamp + acknowledged_by are written by the
    // service/repo from caller_user_id and the current time.
    const outcome = await dineInSessionService.acknowledgeServiceRequest({
      request_id: requestId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
    });

    ok(res, { request: outcome.value.request });
  }),
);

dineInRouter.post(
  "/service-requests/:requestId/complete",
  authenticate,
  asyncHandler(async (req, res) => {
    const requestId = RequestIdSchema.safeParse(req.params.requestId);
    if (!requestId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid request id",
        400,
        requestId.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // No body is read: completion audit fields are server-authoritative.
    const outcome = await dineInSessionService.completeServiceRequest({
      request_id: requestId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
    });

    ok(res, { request: outcome.value.request });
  }),
);

dineInRouter.post(
  "/service-requests/:requestId/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const requestId = RequestIdSchema.safeParse(req.params.requestId);
    if (!requestId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid request id",
        400,
        requestId.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // No body is read. The service-owned BRING_BILL boundary throws
    // BRING_BILL_MANAGED_BY_BILL_FLOW (409) for any BRING_BILL request — the
    // billing flow owns the artifact.
    const outcome = await dineInSessionService.cancelServiceRequest({
      request_id: requestId.data,
      caller_user_id: userId,
      correlation_id: res.locals.correlationId,
    });

    ok(res, { request: outcome.value.request });
  }),
);
