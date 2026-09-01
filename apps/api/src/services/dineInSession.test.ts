import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../middleware/envelope";
import {
  DiningSessionService,
  type AcknowledgeServiceRequestInput,
  type AcknowledgeServiceRequestResult,
  type CancelServiceRequestInput,
  type CancelServiceRequestResult,
  type CompleteServiceRequestInput,
  type CompleteServiceRequestResult,
  type CreateServiceRequestInput,
  type CreateServiceRequestResult,
  type DineInEventFact,
  type MutationOutcome,
  type OpenSessionResult,
  type OpenSessionInput,
  type RequestBillInput,
  type RequestBillResult,
  PUBLIC_SERVICE_REQUEST_CREATE_TYPES,
  OTHER_NOTE_MAX_LENGTH,
} from "./dineInSession";
import { emitDineInEventFactsBestEffort } from "./dineInEventEmitter";
import { mapDineInEventFact } from "./dineInEventMapper";
import type {
  ArtifactLookup,
  DineInTransactionPort,
  DineInTransactionRepos,
  DineInOrderWithItemsDTO,
  DiningSessionDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  SessionBillDTO,
  TableResolveDTO,
  TableResolveRepository,
  TransitionResult,
  TransactionalDiningSessionRepository,
  TransactionalRestaurantReader,
  TransactionalRestaurantTableRepository,
} from "../repositories/dineInContracts";
import type { DiningSessionStatus, ServiceRequestStatus, ServiceRequestType } from "@snakzap/types";
import { calculateBillDraft, type BillDraft } from "./dineInBillArithmetic";

// D2.5C9.2: the service's default post-commit emitter is replaced with a
// mock here so C2-C8 tests stay deterministic and Redis-free. The C9.2 block
// below asserts on the mock. Helper-level failure isolation is tested in
// dineInEventEmitter.test.ts with the real helper + spied eventBus.
vi.mock("./dineInEventEmitter");

// ------------------------------------------------------------
// D2.5C2 focused tests: openSession new-session happy path.
// requestBill must remain a stub; no eventBus is used.
// ------------------------------------------------------------

const baseTable: RestaurantTableDTO = {
  id: "table-1",
  restaurant_id: "rest-1",
  zone_id: null,
  label: "T1",
  table_token: "token",
  seat_count: 4,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const session: DiningSessionDTO = {
  id: "session-1",
  restaurant_id: "rest-1",
  table_id: "table-1",
  owner_user_id: "user-1",
  status: "OPEN",
  bill_requested_at: null,
  payment_pending_at: null,
  closed_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const input: OpenSessionInput = {
  caller_user_id: "user-1",
  table_token: "token",
  correlation_id: "corr-1",
};

function fakeTxPort(
  tables: Partial<TransactionalRestaurantTableRepository>,
  eligibility: Partial<TransactionalRestaurantReader>,
  sessions: Partial<TransactionalDiningSessionRepository>,
): DineInTransactionPort {
  const repos = {
    restaurantTables: tables,
    restaurantEligibility: eligibility,
    diningSessions: sessions,
  } as unknown as DineInTransactionRepos;
  return {
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => fn(repos),
  };
}

function happyRepos() {
  return {
    tables: {
      lockByToken: vi.fn().mockResolvedValue(baseTable),
    },
    eligibility: {
      getEligibility: vi.fn().mockResolvedValue({ id: "rest-1", is_active: true }),
    },
    sessions: {
      lockLiveByTable: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(session),
    },
  };
}

describe("DiningSessionService.openSession happy path (D2.5C2)", () => {
  it("A: valid table + eligible restaurant + no live session -> NEW_MUTATION + CREATED + one SESSION_OPENED fact", async () => {
    const { tables, eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(fakeTxPort(tables, eligibility, sessions));

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;

    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.kind).toBe("CREATED");
    expect(outcome.value.session).toBe(session);
    expect(outcome.eventFacts).toHaveLength(1);
    // toEqual proves the fact contains EXACTLY these fields — any
    // forbidden field (table_token/session_status/correlation_id) would fail.
    expect(outcome.eventFacts[0]).toEqual({
      kind: "SESSION_OPENED",
      session_id: "session-1",
      restaurant_id: "rest-1",
      table_id: "table-1",
      customer_user_id: "user-1",
    });
  });

  it("B: created session facts originate from the locked table, not the caller", async () => {
    const { tables, eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(fakeTxPort(tables, eligibility, sessions));

    await service.openSession(input);

    expect(sessions.create).toHaveBeenCalledWith({
      restaurant_id: "rest-1",
      table_id: "table-1",
      owner_user_id: "user-1",
    });
  });

  it("C: missing table -> TABLE_NOT_FOUND, no create", async () => {
    const { eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(
      fakeTxPort(
        { lockByToken: vi.fn().mockResolvedValue(null) },
        eligibility,
        sessions,
      ),
    );

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("D: disabled table -> TABLE_NOT_FOUND, no create", async () => {
    const { eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(
      fakeTxPort(
        {
          lockByToken: vi
            .fn()
            .mockResolvedValue({ ...baseTable, is_active: false }),
        },
        eligibility,
        sessions,
      ),
    );

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("E: ineligible restaurant -> TABLE_NOT_FOUND, no create", async () => {
    const { tables, sessions } = happyRepos();
    const service = new DiningSessionService(
      fakeTxPort(tables, {
        getEligibility: vi
          .fn()
          .mockResolvedValue({ id: "rest-1", is_active: false }),
      }, sessions),
    );

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

});

describe("DiningSessionService.openSession resume/occupied (D2.5C3)", () => {
  function liveSession(
    status: DiningSessionDTO["status"],
    owner: string,
    id: string,
  ): DiningSessionDTO {
    return { ...session, id, status, owner_user_id: owner };
  }

  async function resumeCase(
    status: DiningSessionDTO["status"],
  ): Promise<void> {
    const { tables, eligibility } = happyRepos();
    const live = liveSession(status, "user-1", "session-1");
    const sessions = {
      lockLiveByTable: vi.fn().mockResolvedValue(live),
      create: vi.fn(),
    };
    const service = new DiningSessionService(
      fakeTxPort(tables, eligibility, sessions),
    );

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;

    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.kind).toBe("RESUMED");
    // The EXACT existing session id is preserved.
    expect(outcome.value.session.id).toBe("session-1");
    expect(outcome.value.session).toBe(live);
    expect(outcome.eventFacts).toEqual([]);
    // No second session created.
    expect(sessions.create).not.toHaveBeenCalled();
  }

  it("A: same-owner + OPEN live session -> RESUMED, same id, IDEMPOTENT_NO_MUTATION, no events", async () => {
    await resumeCase("OPEN");
  });

  it("B: same-owner + ACTIVE -> same behavior", async () => {
    await resumeCase("ACTIVE");
  });

  it("C: same-owner + BILL_REQUESTED -> same behavior", async () => {
    await resumeCase("BILL_REQUESTED");
  });

  it("D: same-owner + PAYMENT_PENDING -> same behavior", async () => {
    await resumeCase("PAYMENT_PENDING");
  });

  it("E: different owner -> TABLE_OCCUPIED, no create, no mutation/event", async () => {
    const { tables, eligibility } = happyRepos();
    const live = liveSession("OPEN", "other-owner", "session-9");
    const sessions = {
      lockLiveByTable: vi.fn().mockResolvedValue(live),
      create: vi.fn(),
    };
    const service = new DiningSessionService(
      fakeTxPort(tables, eligibility, sessions),
    );

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_OCCUPIED",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("F: occupied error does not expose the other owner's identity", async () => {
    const { tables, eligibility } = happyRepos();
    const live = liveSession("OPEN", "other-owner", "session-9");
    const service = new DiningSessionService(
      fakeTxPort(
        tables,
        eligibility,
        {
          lockLiveByTable: vi.fn().mockResolvedValue(live),
          create: vi.fn(),
        },
      ),
    );

    try {
      await service.openSession(input);
      expect.unreachable("openSession should have thrown");
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("TABLE_OCCUPIED");
      expect(e.message).not.toContain("other-owner");
    }
  });

  it("G: C2 new-session happy path still works", async () => {
    const { tables, eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(fakeTxPort(tables, eligibility, sessions));

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.kind).toBe("CREATED");
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("H: TABLE_NOT_FOUND collapse still works", async () => {
    const { eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(
      fakeTxPort(
        { lockByToken: vi.fn().mockResolvedValue(null) },
        eligibility,
        sessions,
      ),
    );
    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("I: requestBill now enters the injected tx port (C5 replaces the stub)", async () => {
    const { tables, eligibility } = happyRepos();
    const sessions = { lockById: vi.fn().mockResolvedValue(null) };
    const service = new DiningSessionService(
      fakeTxPort(tables, eligibility, sessions),
    );
    await expect(
      service.requestBill({
        session_id: "s1",
        caller_user_id: "u1",
        correlation_id: "c1",
      }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

describe("DiningSessionService scaffold boundaries (D2.5C1/C2)", () => {
  it("constructs with a fake transaction port", () => {
    const service = new DiningSessionService(
      fakeTxPort({}, {}, {}),
    );
    expect(service).toBeInstanceOf(DiningSessionService);
  });

  it("MutationOutcome preserves NEW_MUTATION vs IDEMPOTENT_NO_MUTATION", () => {
    const fresh: MutationOutcome<string, DineInEventFact> = {
      kind: "NEW_MUTATION",
      value: "x",
      eventFacts: [
        {
          kind: "SESSION_OPENED",
          session_id: "s1",
          restaurant_id: "r1",
          table_id: "t1",
          customer_user_id: "u1",
        },
      ],
    };
    const repeated: MutationOutcome<string, DineInEventFact> = {
      kind: "IDEMPOTENT_NO_MUTATION",
      value: "x",
      eventFacts: [],
    };
    if (fresh.kind === "NEW_MUTATION") {
      expect(fresh.eventFacts).toHaveLength(1);
    }
    if (repeated.kind === "IDEMPOTENT_NO_MUTATION") {
      expect(repeated.eventFacts).toHaveLength(0);
    }
  });

  it("OpenSessionResult surface represents created and resumed", () => {
    const created: OpenSessionResult = { kind: "CREATED", session: session };
    const resumed: OpenSessionResult = { kind: "RESUMED", session: session };
    expect(created.kind).toBe("CREATED");
    expect(resumed.kind).toBe("RESUMED");
  });
});

describe("DiningSessionService.openSession unique-race recovery (D2.5C4)", () => {
  // Shape of a node-postgres unique-violation error that Drizzle's
  // db.transaction propagates unchanged.
  const liveUniqueViolation = Object.assign(
    new Error("duplicate key value violates unique constraint"),
    { code: "23505", constraint: "dining_sessions_live_table_idx" },
  );

  function makeRepos(opts: {
    table?: RestaurantTableDTO | null;
    eligibilityActive?: boolean;
    live?: DiningSessionDTO | null;
    createImpl?: () => unknown;
  }) {
    const lockByToken = vi
      .fn()
      .mockResolvedValue(opts.table === undefined ? baseTable : opts.table);
    const getEligibility = vi.fn().mockResolvedValue({
      id: "rest-1",
      is_active: opts.eligibilityActive ?? true,
    });
    const lockLiveByTable = vi.fn().mockResolvedValue(opts.live ?? null);
    const create = opts.createImpl
      ? vi.fn(opts.createImpl)
      : vi.fn().mockResolvedValue(session);
    return {
      repos: {
        restaurantTables: { lockByToken },
        restaurantEligibility: { getEligibility },
        diningSessions: { lockLiveByTable, create },
      },
      mocks: { lockByToken, getEligibility, lockLiveByTable, create },
    };
  }

  // Sequence-aware fake port: call 1 uses `first`, call 2 uses `second`.
  function makeSequencedPort(
    first: ReturnType<typeof makeRepos>,
    second: ReturnType<typeof makeRepos>,
  ) {
    const port = {
      calls: 0,
      async runInTransaction<T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> {
        port.calls += 1;
        const bundle = port.calls === 1 ? first : second;
        return fn(bundle.repos as unknown as DineInTransactionRepos);
      },
    };
    return port;
  }

  it("A: first create succeeds normally -> NEW_MUTATION + SESSION_OPENED, single tx", async () => {
    const first = makeRepos({});
    const port = makeSequencedPort(first, makeRepos({}));
    const service = new DiningSessionService(port);

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.kind).toBe("CREATED");
    expect(outcome.eventFacts[0]).toMatchObject({ kind: "SESSION_OPENED" });
    expect(port.calls).toBe(1);
  });

  it("B: recognized unique violation -> first tx exits, exactly one fresh tx invoked", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    const winner = makeRepos({ live: { ...session, id: "session-winner" } });
    const port = makeSequencedPort(first, winner);
    const service = new DiningSessionService(port);

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(port.calls).toBe(2);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
  });

  it("C: recovery finds same-owner winner -> RESUMED with exact winner id, IDEMPOTENT_NO_MUTATION, no events", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    const winner = makeRepos({ live: { ...session, id: "session-winner" } });
    const port = makeSequencedPort(first, winner);
    const service = new DiningSessionService(port);

    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.kind).toBe("RESUMED");
    expect(outcome.value.session.id).toBe("session-winner");
    expect(outcome.eventFacts).toEqual([]);
  });

  it("D: recovery finds different-owner winner -> TABLE_OCCUPIED, no create", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    const winner = makeRepos({
      live: { ...session, id: "session-winner", owner_user_id: "other-owner" },
    });
    const port = makeSequencedPort(first, winner);
    const service = new DiningSessionService(port);

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_OCCUPIED",
    });
    expect(port.calls).toBe(2);
    expect(winner.mocks.create).not.toHaveBeenCalled();
  });

  it("E: no authoritative query in the aborted first tx after failed create", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    const winner = makeRepos({ live: { ...session, id: "session-winner" } });
    const port = makeSequencedPort(first, winner);
    const service = new DiningSessionService(port);

    await service.openSession(input);

    // First tx: lockLiveByTable exactly once (pre-create check), then create
    // throws -> callback aborts. Nothing is queried on the first repos after
    // the failed create (recovery uses the SECOND fresh repos only).
    expect(first.mocks.lockLiveByTable).toHaveBeenCalledTimes(1);
    expect(first.mocks.create).toHaveBeenCalledTimes(1);
    expect(winner.mocks.lockLiveByTable).toHaveBeenCalledTimes(1);
  });

  it("F: recognized violation but fresh tx finds no live session -> INTERNAL_ERROR, no third attempt", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    const empty = makeRepos({ live: null });
    const port = makeSequencedPort(first, empty);
    const service = new DiningSessionService(port);

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(port.calls).toBe(2);
    expect(empty.mocks.create).not.toHaveBeenCalled();
  });

  it("G: unrelated unique violation -> propagates original error, no recovery", async () => {
    const unrelated = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      { code: "23505", constraint: "some_other_idx" },
    );
    const first = makeRepos({ createImpl: () => { throw unrelated; } });
    const port = makeSequencedPort(first, makeRepos({}));
    const service = new DiningSessionService(port);

    await expect(service.openSession(input)).rejects.toBe(unrelated);
    expect(port.calls).toBe(1);
  });

  it("H: arbitrary DB error -> propagates, no recovery", async () => {
    const arbitrary = Object.assign(new Error("connection reset"), { code: "57014" });
    const first = makeRepos({ createImpl: () => { throw arbitrary; } });
    const port = makeSequencedPort(first, makeRepos({}));
    const service = new DiningSessionService(port);

    await expect(service.openSession(input)).rejects.toBe(arbitrary);
    expect(port.calls).toBe(1);
  });

  it("I: recovery revalidates table/eligibility from the fresh tx", async () => {
    const first = makeRepos({ createImpl: () => { throw liveUniqueViolation; } });
    // Fresh tx sees the table as gone (or disabled/ineligible) -> TABLE_NOT_FOUND.
    const gone = makeRepos({ table: null });
    const port = makeSequencedPort(first, gone);
    const service = new DiningSessionService(port);

    await expect(service.openSession(input)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
    expect(gone.mocks.lockByToken).toHaveBeenCalledTimes(1);
    expect(port.calls).toBe(2);
  });

  it("J: C2/C3 paths remain green (happy create + same-owner resume, single tx each)", async () => {
    const createPort = makeSequencedPort(makeRepos({}), makeRepos({}));
    const createService = new DiningSessionService(createPort);
    const created = (await createService.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(created.kind).toBe("NEW_MUTATION");
    expect(createPort.calls).toBe(1);

    const resumePort = makeSequencedPort(
      makeRepos({ live: { ...session, id: "session-1" } }),
      makeRepos({}),
    );
    const resumeService = new DiningSessionService(resumePort);
    const resumed = (await resumeService.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(resumed.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(resumed.value.kind).toBe("RESUMED");
    expect(resumePort.calls).toBe(1);
  });
});

// ------------------------------------------------------------
// Shared requestBill fixtures (module scope: reused by the C5 state-gate and
// C6 ACTIVE-arithmetic describe blocks).
// ------------------------------------------------------------
const rbInput: RequestBillInput = {
  session_id: "session-rb",
  caller_user_id: "user-1",
  correlation_id: "corr-rb",
};

function rbSession(over: Partial<DiningSessionDTO>): DiningSessionDTO {
  return {
    id: "session-rb",
    restaurant_id: "rest-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const rbBill: SessionBillDTO = {
  id: "bill-1",
  session_id: "session-rb",
  restaurant_id: "rest-1",
  food_subtotal: 100,
  packaging_fee: 10,
  gst_food: 5,
  gst_packaging: 0,
  total_amount: 115,
  frozen_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

const bringBill: ServiceRequestDTO = {
  id: "req-1",
  session_id: "session-rb",
  restaurant_id: "rest-1",
  requested_by: "user-1",
  request_type: "BRING_BILL",
  status: "PENDING",
  note: null,
  acknowledged_by: null,
  acknowledged_at: null,
  completed_by: null,
  completed_at: null,
  cancelled_by: null,
  cancelled_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

interface RBOpts {
  session?: DiningSessionDTO | null;
  bill?: SessionBillDTO | null;
  bringBillLookup?: ArtifactLookup<ServiceRequestDTO>;
  billableOrders?: DineInOrderWithItemsDTO[];
  billInsertImpl?: () => SessionBillDTO;
  transitionResult?: TransitionResult<DiningSessionDTO, DiningSessionStatus>;
  requestCreateImpl?: () => ServiceRequestDTO;
}

function defaultFrozenBill(sid: string): SessionBillDTO {
  return {
    ...rbBill,
    id: "bill-frozen",
    session_id: sid,
    food_subtotal: 100,
    packaging_fee: 0,
    gst_food: 5,
    gst_packaging: 0,
    total_amount: 105,
  };
}

function defaultCreatedRequest(sid: string): ServiceRequestDTO {
  return { ...bringBill, id: "req-frozen", session_id: sid };
}

function defaultTransition(
  session: DiningSessionDTO | null | undefined,
): TransitionResult<DiningSessionDTO, DiningSessionStatus> {
  if (!session) return { kind: "NOT_FOUND" };
  return {
    kind: "UPDATED",
    value: {
      ...session,
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeRbPort(opts: RBOpts) {
  const sid =
    opts.session && typeof opts.session === "object" ? opts.session.id : "session-rb";
  const mocks = {
    lockById: vi.fn().mockResolvedValue(
      opts.session === undefined ? null : opts.session,
    ),
    getBySessionId: vi.fn().mockResolvedValue(
      opts.bill === undefined ? null : opts.bill,
    ),
    findBringBillBySession: vi.fn().mockResolvedValue(
      opts.bringBillLookup ?? { kind: "NONE" as const },
    ),
    listForBill: vi.fn().mockResolvedValue(opts.billableOrders ?? []),
    createFrozenBill: opts.billInsertImpl
      ? vi.fn(opts.billInsertImpl)
      : vi.fn().mockResolvedValue(defaultFrozenBill(sid)),
    transitionStatus: vi
      .fn()
      .mockResolvedValue(opts.transitionResult ?? defaultTransition(opts.session)),
    createRequest: opts.requestCreateImpl
      ? vi.fn(opts.requestCreateImpl)
      : vi.fn().mockResolvedValue(defaultCreatedRequest(sid)),
  };
  const repos = {
    diningSessions: {
      lockById: mocks.lockById,
      transitionStatus: mocks.transitionStatus,
    },
    sessionBills: {
      getBySessionId: mocks.getBySessionId,
      createFrozenBill: mocks.createFrozenBill,
    },
    serviceRequests: {
      findBringBillBySession: mocks.findBringBillBySession,
      create: mocks.createRequest,
    },
    dineInOrders: {
      listForBill: mocks.listForBill,
    },
  } as unknown as DineInTransactionRepos;
  const port = {
    txCalls: 0,
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => {
      port.txCalls += 1;
      return fn(repos);
    },
  };
  return { port, mocks };
}

function orderWithItems(
  items: Array<{ item_subtotal: number }>,
  over: Partial<DineInOrderWithItemsDTO> = {},
): DineInOrderWithItemsDTO {
  return {
    id: "order-1",
    session_id: "session-rb",
    restaurant_id: "rest-1",
    placed_by: "user-1",
    status: "SERVED",
    total_amount: 12345,
    notes: null,
    served_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    items: items.map((it, idx) => ({
      id: `item-${idx}`,
      dine_in_order_id: "order-1",
      restaurant_id: "rest-1",
      menu_item_id: "menu-1",
      name: "dish",
      base_price: 999,
      quantity: 1,
      customizations: [],
      customization_total: 0,
      item_subtotal: it.item_subtotal,
      created_at: "2026-01-01T00:00:00.000Z",
    })),
    ...over,
  };
}

describe("DiningSessionService.requestBill state gate (D2.5C5)", () => {
  it("A: SESSION_NOT_FOUND when session absent", async () => {
    const { port } = makeRbPort({ session: null });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("B: owner mismatch collapses to SESSION_NOT_FOUND with no owner leakage", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ owner_user_id: "other-owner" }),
    });
    const service = new DiningSessionService(port);
    try {
      await service.requestBill(rbInput);
      expect.unreachable("requestBill should have thrown");
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("SESSION_NOT_FOUND");
      expect(e.message).not.toContain("other-owner");
    }
    expect(mocks.getBySessionId).not.toHaveBeenCalled();
  });

  it("C: OPEN -> SESSION_NOT_BILLABLE, no reads/writes", async () => {
    const { port, mocks } = makeRbPort({ session: rbSession({ status: "OPEN" }) });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "SESSION_NOT_BILLABLE",
    });
    expect(mocks.getBySessionId).not.toHaveBeenCalled();
    expect(mocks.createFrozenBill).not.toHaveBeenCalled();
  });

  it("D: ACTIVE valid request now freezes (C7) — single tx, all three writes", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      billableOrders: [orderWithItems([{ item_subtotal: 50 }])],
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(port.txCalls).toBe(1);
    expect(mocks.createFrozenBill).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("E: ACTIVE + existing bill -> BILL_INVARIANT_VIOLATION, no writes", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: rbBill,
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
    expect(mocks.createFrozenBill).not.toHaveBeenCalled();
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
  });

  it("F: BILL_REQUESTED + bill + FOUND artifact -> IDEMPOTENT_NO_MUTATION, []", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "FOUND", value: bringBill },
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.session.id).toBe("session-rb");
    expect(outcome.value.bill).toBe(rbBill);
    expect(outcome.value.bringBillRequest).toBe(bringBill);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("G: BILL_REQUESTED + no bill -> BILL_INVARIANT_VIOLATION", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: null,
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
  });

  it("H: BILL_REQUESTED + artifact NONE -> BILL_INVARIANT_VIOLATION", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "NONE" },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
  });

  it("I: BILL_REQUESTED + artifact MULTIPLE -> BILL_INVARIANT_VIOLATION", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "MULTIPLE", values: [bringBill, bringBill] },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
  });

  it("J: PAYMENT_PENDING + bill -> IDEMPOTENT_NO_MUTATION, no artifact read", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "PAYMENT_PENDING" }),
      bill: rbBill,
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.bill).toBe(rbBill);
    expect(outcome.value.bringBillRequest).toBeNull();
    expect(outcome.eventFacts).toEqual([]);
    // BRING_BILL is NOT re-read/required on this branch.
    expect(mocks.findBringBillBySession).not.toHaveBeenCalled();
  });

  it("K: PAYMENT_PENDING + missing bill -> BILL_INVARIANT_VIOLATION", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "PAYMENT_PENDING" }),
      bill: null,
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
  });

  it("L: CLOSED -> frozen closed/not-billable conflict (SESSION_NOT_BILLABLE)", async () => {
    const { port, mocks } = makeRbPort({ session: rbSession({ status: "CLOSED" }) });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "SESSION_NOT_BILLABLE",
    });
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
  });

  it("M: first authoritative operation is diningSessions.lockById", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "FOUND", value: bringBill },
    });
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);

    const lockOrder = mocks.lockById.mock.invocationCallOrder[0]!;
    const billOrder = mocks.getBySessionId.mock.invocationCallOrder[0]!;
    const lookupOrder = mocks.findBringBillBySession.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(billOrder);
    expect(billOrder).toBeLessThan(lookupOrder);
  });

  it("N: no mutation method invoked in any C5 path", async () => {
    const branches: RBOpts[] = [
      { session: rbSession({ status: "OPEN" }) },
      { session: rbSession({ status: "ACTIVE" }) },
      { session: rbSession({ status: "ACTIVE" }), bill: rbBill },
      {
        session: rbSession({ status: "BILL_REQUESTED" }),
        bill: rbBill,
        bringBillLookup: { kind: "FOUND", value: bringBill },
      },
      { session: rbSession({ status: "PAYMENT_PENDING" }), bill: rbBill },
      { session: rbSession({ status: "CLOSED" }) },
    ];
    for (const opts of branches) {
      const { port, mocks } = makeRbPort(opts);
      const service = new DiningSessionService(port);
      await service.requestBill(rbInput).catch(() => undefined);
      expect(mocks.createFrozenBill).not.toHaveBeenCalled();
      expect(mocks.createRequest).not.toHaveBeenCalled();
      expect(mocks.transitionStatus).not.toHaveBeenCalled();
    }
  });

  it("N2: no bill recalculation (listForBill) on repeat/error branches", async () => {
    const noCalcBranches: RBOpts[] = [
      { session: rbSession({ status: "OPEN" }) },
      { session: rbSession({ status: "ACTIVE" }), bill: rbBill },
      {
        session: rbSession({ status: "BILL_REQUESTED" }),
        bill: rbBill,
        bringBillLookup: { kind: "FOUND", value: bringBill },
      },
      { session: rbSession({ status: "PAYMENT_PENDING" }), bill: rbBill },
      { session: rbSession({ status: "CLOSED" }) },
    ];
    for (const opts of noCalcBranches) {
      const { port, mocks } = makeRbPort(opts);
      const service = new DiningSessionService(port);
      await service.requestBill(rbInput).catch(() => undefined);
      expect(mocks.listForBill).not.toHaveBeenCalled();
    }
  });

  it("O: openSession C2-C4 regression remains green", async () => {
    const firstRepos = {
      restaurantTables: {
        lockByToken: vi.fn().mockResolvedValue(baseTable),
      },
      restaurantEligibility: {
        getEligibility: vi.fn().mockResolvedValue({ id: "rest-1", is_active: true }),
      },
      diningSessions: {
        lockLiveByTable: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(session),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      calls: 0,
      async runInTransaction<T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> {
        port.calls += 1;
        return fn(firstRepos);
      },
    };
    const service = new DiningSessionService(port);
    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(port.calls).toBe(1);
  });
});

describe("DineInBillArithmetic pure session-level calculation (D2.5C6)", () => {
  it("A: one item subtotal -> correct food_subtotal/GST/total", () => {
    const draft: BillDraft = calculateBillDraft([100]);
    expect(draft).toEqual({
      food_subtotal: 100,
      packaging_fee: 0,
      gst_food: 5,
      gst_packaging: 0,
      total_amount: 105,
    });
  });

  it("B: multiple orders/items -> sum of item_subtotal snapshots across session", () => {
    const draft: BillDraft = calculateBillDraft([40.5, 9.5, 50]);
    expect(draft.food_subtotal).toBe(100);
    expect(draft.gst_food).toBe(5);
    expect(draft.total_amount).toBe(105);
  });

  it("C: rounding once at session level, not per-item GST accumulation", () => {
    // Items summing to a value whose session-level 5% is exact, whereas
    // per-item GST rounding would drift. Items: 0.01, 0.01, 0.01, 0.01, 0.01,
    // 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
    // 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02 -> sum 0.50
    const items = [
      0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01,
      0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
      0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
    ];
    const draft: BillDraft = calculateBillDraft(items);
    // sum = 10 * 0.01 + 20 * 0.02 = 0.10 + 0.40 = 0.50
    expect(draft.food_subtotal).toBe(0.5);
    // session-level 5% of 0.50 = 0.025 -> round2 = 0.03
    expect(draft.gst_food).toBe(0.03);
    expect(draft.total_amount).toBe(0.53);
  });

  it("D: packaging_fee frozen to 0", () => {
    const draft: BillDraft = calculateBillDraft([200]);
    expect(draft.packaging_fee).toBe(0);
  });

  it("E: gst_packaging frozen to 0", () => {
    const draft: BillDraft = calculateBillDraft([200]);
    expect(draft.gst_packaging).toBe(0);
  });

  it("F: no commission/discount/tip/payment fee in result", () => {
    const draft: BillDraft = calculateBillDraft([200]);
    expect(Object.keys(draft).sort()).toEqual([
      "food_subtotal",
      "gst_food",
      "gst_packaging",
      "packaging_fee",
      "total_amount",
    ]);
  });

  it("G: bill calculation follows item_subtotal snapshots only (no order.total_amount input exists)", () => {
    // The helper accepts ONLY item_subtotal numbers — there is no way for a
    // DineInOrder.total_amount or menu/base_price to influence it.
    const draft: BillDraft = calculateBillDraft([64.5, 35.5]);
    expect(draft.food_subtotal).toBe(100);
    expect(draft.total_amount).toBe(105);
  });

  it("H: zero-priced snapshots are valid billable items (not an invariant breach)", () => {
    // A legitimate zero-priced item is still a billable snapshot.
    const draft: BillDraft = calculateBillDraft([0, 0]);
    expect(draft.food_subtotal).toBe(0);
    expect(draft.total_amount).toBe(0);
  });
});

describe("DiningSessionService.requestBill ACTIVE arithmetic integration (D2.5C6)", () => {
  it("I: zero billable orders -> BILL_INVARIANT_VIOLATION, no listForBill arithmetic", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      billableOrders: [],
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
    expect(mocks.listForBill).toHaveBeenCalledWith("session-rb");
  });

  it("J: orders with no billable item snapshots -> BILL_INVARIANT_VIOLATION", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      billableOrders: [orderWithItems([])],
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
  });

  it("K: ACTIVE + existing bill fails BEFORE listForBill", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: rbBill,
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
    expect(mocks.listForBill).not.toHaveBeenCalled();
  });

  it("L: ACTIVE valid arithmetic feeds the freeze — persisted bill equals C6 draft values", async () => {
    const { port, mocks } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      // total_amount deliberately 12345 and base_price 999: both ignored;
      // item_subtotal snapshots 40.5 + 9.5 + 50 -> subtotal 100, GST 5, total 105
      billableOrders: [
        orderWithItems([{ item_subtotal: 40.5 }, { item_subtotal: 9.5 }]),
        orderWithItems([{ item_subtotal: 50 }]),
      ],
    });
    const service = new DiningSessionService(port);

    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    // createFrozenBill received the exact C6 draft values (no recomputation).
    expect(mocks.createFrozenBill).toHaveBeenCalledWith({
      session_id: "session-rb",
      restaurant_id: "rest-1",
      food_subtotal: 100,
      packaging_fee: 0,
      gst_food: 5,
      gst_packaging: 0,
      total_amount: 105,
    });
    expect(mocks.listForBill).toHaveBeenCalledWith("session-rb");
  });

  it("M: BILL_REQUESTED/PAYMENT_PENDING repeat behavior unchanged", async () => {
    const { port: brPort } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "FOUND", value: bringBill },
    });
    const br = new DiningSessionService(brPort);
    const brOutcome = (await br.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(brOutcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(brOutcome.value.bringBillRequest).toBe(bringBill);

    const { port: ppPort, mocks: ppMocks } = makeRbPort({
      session: rbSession({ status: "PAYMENT_PENDING" }),
      bill: rbBill,
    });
    const pp = new DiningSessionService(ppPort);
    const ppOutcome = (await pp.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(ppOutcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(ppOutcome.value.bringBillRequest).toBeNull();
    expect(ppMocks.findBringBillBySession).not.toHaveBeenCalled();
  });

  it("N: openSession C2-C4 regression remains green", async () => {
    const firstRepos = {
      restaurantTables: {
        lockByToken: vi.fn().mockResolvedValue(baseTable),
      },
      restaurantEligibility: {
        getEligibility: vi.fn().mockResolvedValue({ id: "rest-1", is_active: true }),
      },
      diningSessions: {
        lockLiveByTable: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(session),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      calls: 0,
      async runInTransaction<T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> {
        port.calls += 1;
        return fn(firstRepos);
      },
    };
    const service = new DiningSessionService(port);
    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(port.calls).toBe(1);
  });
});

describe("DiningSessionService.requestBill atomic freeze (D2.5C7)", () => {
  function freezePort(over: Partial<RBOpts> = {}) {
    return makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      billableOrders: [orderWithItems([{ item_subtotal: 100 }])],
      ...over,
    });
  }

  it("A: successful ACTIVE freeze -> each write once, NEW_MUTATION", async () => {
    const { port, mocks } = freezePort();
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(mocks.createFrozenBill).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
    expect(port.txCalls).toBe(1);
  });

  it("B: write order is bill insert -> session transition -> request create", async () => {
    const { port, mocks } = freezePort();
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);
    const billOrder = mocks.createFrozenBill.mock.invocationCallOrder[0]!;
    const transitionOrder = mocks.transitionStatus.mock.invocationCallOrder[0]!;
    const requestOrder = mocks.createRequest.mock.invocationCallOrder[0]!;
    expect(billOrder).toBeLessThan(transitionOrder);
    expect(transitionOrder).toBeLessThan(requestOrder);
  });

  it("C: result carries persisted bill, updated BILL_REQUESTED session, persisted request", async () => {
    const { port } = freezePort();
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.value.session.status).toBe("BILL_REQUESTED");
    expect(outcome.value.session.bill_requested_at).toBe("2026-01-01T00:00:00.000Z");
    expect(outcome.value.bill.id).toBe("bill-frozen");
    expect(outcome.value.bringBillRequest!.id).toBe("req-frozen");
  });

  it("D: bill values equal exact C6 BillDraft (no recomputation)", async () => {
    const { port, mocks } = freezePort({
      billableOrders: [
        orderWithItems([{ item_subtotal: 64.5 }, { item_subtotal: 35.5 }]),
      ],
    });
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);
    // 64.5 + 35.5 = 100 food, GST 5, total 105 — exactly the C6 draft.
    expect(mocks.createFrozenBill).toHaveBeenCalledWith({
      session_id: "session-rb",
      restaurant_id: "rest-1",
      food_subtotal: 100,
      packaging_fee: 0,
      gst_food: 5,
      gst_packaging: 0,
      total_amount: 105,
    });
  });

  it("E: restaurant_id/session_id come from the locked authoritative session", async () => {
    const { port, mocks } = freezePort({
      session: rbSession({
        id: "session-xyz",
        restaurant_id: "rest-xyz",
        status: "ACTIVE",
      }),
    });
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);
    expect(mocks.createFrozenBill).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-xyz",
        restaurant_id: "rest-xyz",
      }),
    );
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-xyz",
        restaurant_id: "rest-xyz",
      }),
    );
  });

  it("F: BRING_BILL request type/status exact", async () => {
    const { port, mocks } = freezePort();
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ request_type: "BRING_BILL" }),
    );
    expect(outcome.value.bringBillRequest!.request_type).toBe("BRING_BILL");
    expect(outcome.value.bringBillRequest!.status).toBe("PENDING");
  });

  it("G: bill insert failure -> transition/request not attempted, transaction rejects", async () => {
    const insertError = new Error("insert failed");
    const { port, mocks } = freezePort({
      billInsertImpl: () => {
        throw insertError;
      },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toBe(insertError);
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("H: session transition STATE_MISMATCH -> request not created, transaction rejects", async () => {
    const { port, mocks } = freezePort({
      transitionResult: { kind: "STATE_MISMATCH", current: "BILL_REQUESTED" },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("I: session transition NOT_FOUND -> transaction rejects", async () => {
    const { port, mocks } = freezePort({
      transitionResult: { kind: "NOT_FOUND" },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "BILL_INVARIANT_VIOLATION",
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("J: BRING_BILL create failure -> transaction rejects, no successful result", async () => {
    const createError = new Error("request create failed");
    const { port } = freezePort({
      requestCreateImpl: () => {
        throw createError;
      },
    });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toBe(createError);
  });

  it("K: all three writes run inside the SAME transaction callback", async () => {
    const { port, mocks } = freezePort();
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);
    expect(port.txCalls).toBe(1);
    expect(mocks.createFrozenBill).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("L: no nested transaction (single runInTransaction per requestBill)", async () => {
    const { port } = freezePort();
    const service = new DiningSessionService(port);
    await service.requestBill(rbInput);
    expect(port.txCalls).toBe(1);
  });

  it("M: successful freeze returns exactly 2 semantic event facts with authoritative payload", async () => {
    const { port } = freezePort();
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(2);
    // toEqual proves EXACT shape: no event_id, no timestamp, no envelope.
    expect(outcome.eventFacts[0]).toEqual({
      kind: "BILL_REQUESTED",
      session_id: "session-rb",
      bill_id: "bill-frozen",
      restaurant_id: "rest-1",
      table_id: "table-1",
      total_amount: 105,
    });
    expect(outcome.eventFacts[1]).toEqual({
      kind: "SERVICE_REQUEST_CREATED",
      request_id: "req-frozen",
      session_id: "session-rb",
      restaurant_id: "rest-1",
      request_type: "BRING_BILL" as ServiceRequestType,
      request_status: "PENDING",
    });
  });

  it("N: no actual EventBus emission (semantic facts only)", async () => {
    const { port } = freezePort();
    const service = new DiningSessionService(port);
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    // The service has no eventBus dependency; facts are plain data.
    expect(outcome.eventFacts).toHaveLength(2);
  });

  it("O: C5 repeat paths unchanged", async () => {
    const { port: brPort } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "FOUND", value: bringBill },
    });
    const br = new DiningSessionService(brPort);
    const brOutcome = (await br.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(brOutcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(brOutcome.eventFacts).toEqual([]);

    const { port: ppPort } = makeRbPort({
      session: rbSession({ status: "PAYMENT_PENDING" }),
      bill: rbBill,
    });
    const pp = new DiningSessionService(ppPort);
    const ppOutcome = (await pp.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(ppOutcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(ppOutcome.value.bringBillRequest).toBeNull();
  });

  it("P: C6 arithmetic tests unchanged", () => {
    const draft = calculateBillDraft([100]);
    expect(draft).toEqual({
      food_subtotal: 100,
      packaging_fee: 0,
      gst_food: 5,
      gst_packaging: 0,
      total_amount: 105,
    });
  });

  it("Q: openSession C2-C4 regression remains green", async () => {
    const firstRepos = {
      restaurantTables: {
        lockByToken: vi.fn().mockResolvedValue(baseTable),
      },
      restaurantEligibility: {
        getEligibility: vi.fn().mockResolvedValue({ id: "rest-1", is_active: true }),
      },
      diningSessions: {
        lockLiveByTable: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(session),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      calls: 0,
      async runInTransaction<T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> {
        port.calls += 1;
        return fn(firstRepos);
      },
    };
    const service = new DiningSessionService(port);
    const outcome = (await service.openSession(input)) as MutationOutcome<
      OpenSessionResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(port.calls).toBe(1);
  });
});

describe("DiningSessionService post-commit emission (D2.5C9.2)", () => {
  beforeEach(() => {
    vi.mocked(emitDineInEventFactsBestEffort).mockClear();
  });

  it("A: openSession NEW_MUTATION emits SessionOpened once AFTER tx resolves", async () => {
    const { tables, eligibility, sessions } = happyRepos();
    const service = new DiningSessionService(
      fakeTxPort(tables, eligibility, sessions),
    );
    const outcome = await service.openSession(input);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledWith(
      [
        {
          kind: "SESSION_OPENED",
          session_id: "session-1",
          restaurant_id: "rest-1",
          table_id: "table-1",
          customer_user_id: "user-1",
        },
      ],
      "corr-1",
    );
  });

  it("B: same-owner resume (IDEMPOTENT_NO_MUTATION) emits zero", async () => {
    const { tables, eligibility } = happyRepos();
    const live: DiningSessionDTO = {
      ...session,
      id: "session-1",
      status: "OPEN",
      owner_user_id: "user-1",
    };
    const service = new DiningSessionService(
      fakeTxPort(tables, eligibility, {
        lockLiveByTable: vi.fn().mockResolvedValue(live),
        create: vi.fn(),
      }),
    );
    const outcome = await service.openSession(input);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("C: requestBill first freeze emits exactly two events with correlation_id", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "ACTIVE" }),
      bill: null,
      billableOrders: [orderWithItems([{ item_subtotal: 100 }])],
    });
    const service = new DiningSessionService(port);
    const outcome = await service.requestBill(rbInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts, correlationId] = vi.mocked(emitDineInEventFactsBestEffort)
      .mock.calls[0]!;
    expect(facts).toHaveLength(2);
    expect(facts[0]!.kind).toBe("BILL_REQUESTED");
    expect(facts[1]!.kind).toBe("SERVICE_REQUEST_CREATED");
    expect(correlationId).toBe("corr-rb");
  });

  it("G: emission is never invoked inside the transaction callback", async () => {
    const order: string[] = [];
    const { tables, eligibility, sessions } = happyRepos();
    const repos = {
      restaurantTables: tables,
      restaurantEligibility: eligibility,
      diningSessions: sessions,
    } as unknown as DineInTransactionRepos;
    const port: DineInTransactionPort = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        order.push("tx-callback-start");
        const result = await fn(repos);
        order.push("tx-callback-end");
        return result;
      },
    };
    vi.mocked(emitDineInEventFactsBestEffort).mockImplementation(async () => {
      order.push("emit");
    });
    const service = new DiningSessionService(port);
    await service.openSession(input);
    // tx callback fully resolves BEFORE any emission.
    expect(order.indexOf("tx-callback-end")).toBeLessThan(order.indexOf("emit"));
    expect(order.filter((e) => e === "emit")).toHaveLength(1);
  });

  it("H: transaction failure -> zero emission", async () => {
    const { port } = makeRbPort({ session: null });
    const service = new DiningSessionService(port);
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("L: BILL_REQUESTED repeat emits zero", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "BILL_REQUESTED" }),
      bill: rbBill,
      bringBillLookup: { kind: "FOUND", value: bringBill },
    });
    const service = new DiningSessionService(port);
    const outcome = await service.requestBill(rbInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.eventFacts).toEqual([]);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("M: PAYMENT_PENDING repeat emits zero", async () => {
    const { port } = makeRbPort({
      session: rbSession({ status: "PAYMENT_PENDING" }),
      bill: rbBill,
    });
    const service = new DiningSessionService(port);
    const outcome = await service.requestBill(rbInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.eventFacts).toEqual([]);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// D2.5E1 focused tests: createServiceRequest boundary.
// Service-layer only: session lock -> ownership collapse -> state gate ->
// public create-type allowlist -> OTHER note rule -> one PENDING insert.
// No ACK/COMPLETE/CANCEL, no assignment, no session/bill/payment writes.
// (Emission of the created event is covered by the D2.5G1 block below.)
// BRING_BILL is never creatable via this generic command.
// ------------------------------------------------------------

const csrInput = (
  over: Partial<CreateServiceRequestInput> = {},
): CreateServiceRequestInput => ({
  session_id: "session-e1",
  caller_user_id: "user-1",
  correlation_id: "corr-e1",
  request_type: "WATER",
  ...over,
});

function csrSession(over: Partial<DiningSessionDTO>): DiningSessionDTO {
  return {
    id: "session-e1",
    restaurant_id: "rest-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function csrRequest(
  over: Partial<ServiceRequestDTO> = {},
): ServiceRequestDTO {
  return {
    id: "req-e1",
    session_id: "session-e1",
    restaurant_id: "rest-1",
    requested_by: "user-1",
    request_type: "WATER",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeCsrPort(
  session: DiningSessionDTO | null,
  created: ServiceRequestDTO = csrRequest(),
) {
  const mocks = {
    lockById: vi.fn().mockResolvedValue(session),
    createRequest: vi.fn().mockResolvedValue(created),
    sessionTransition: vi.fn(),
    sessionCreate: vi.fn(),
    getBySessionId: vi.fn(),
    listForBill: vi.fn(),
    createFrozenBill: vi.fn(),
    assignmentGetActive: vi.fn(),
    assignmentCreate: vi.fn(),
  };
  const repos = {
    diningSessions: {
      lockById: mocks.lockById,
      transitionStatus: mocks.sessionTransition,
      create: mocks.sessionCreate,
    },
    serviceRequests: {
      create: mocks.createRequest,
    },
    sessionBills: {
      getBySessionId: mocks.getBySessionId,
      createFrozenBill: mocks.createFrozenBill,
    },
    dineInOrders: {
      listForBill: mocks.listForBill,
    },
    staffAssignments: {
      getActiveBySession: mocks.assignmentGetActive,
      create: mocks.assignmentCreate,
    },
  } as unknown as DineInTransactionRepos;
  const port = {
    txCalls: 0,
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => {
      port.txCalls += 1;
      return fn(repos);
    },
  };
  return { port, mocks };
}

describe("DiningSessionService.createServiceRequest boundary (D2.5E1)", () => {
  it("A. OPEN owner + WATER -> NEW_MUTATION with a PENDING request", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("PENDING");
    expect(outcome.value.request.request_type).toBe("WATER");
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("B. ACTIVE owner is allowed", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "ACTIVE" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("C. BILL_REQUESTED owner is allowed", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "BILL_REQUESTED" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("D. PAYMENT_PENDING owner is allowed", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "PAYMENT_PENDING" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("E. CLOSED session -> SESSION_CLOSED_FOR_REQUEST 409 with no insert", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "CLOSED" }));
    const service = new DiningSessionService(port);
    await expect(service.createServiceRequest(csrInput())).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_REQUEST",
      status: 409,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("F. missing session -> SESSION_NOT_FOUND 404", async () => {
    const { port, mocks } = makeCsrPort(null);
    const service = new DiningSessionService(port);
    await expect(service.createServiceRequest(csrInput())).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("G. owner mismatch collapses to SESSION_NOT_FOUND 404", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ owner_user_id: "user-other" }));
    const service = new DiningSessionService(port);
    await expect(service.createServiceRequest(csrInput())).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("H. BRING_BILL is rejected from generic create -> BRING_BILL_MANAGED_BY_BILL_FLOW 409", async () => {
    // The public create allowlist never exposes BRING_BILL at the type level,
    // and the runtime boundary rejects it defensively even if it arrives.
    expect(PUBLIC_SERVICE_REQUEST_CREATE_TYPES).not.toContain("BRING_BILL");
    // @ts-expect-error BRING_BILL is not a public create type
    const illegal: (typeof PUBLIC_SERVICE_REQUEST_CREATE_TYPES)[number] = "BRING_BILL";
    void illegal;
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(csrInput({ request_type: "BRING_BILL" })),
    ).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
      status: 409,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("I. unknown type -> INVALID_REQUEST_TYPE 400", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(
        csrInput({ request_type: "FLAMINGO" as unknown as CreateServiceRequestInput["request_type"] }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST_TYPE",
      status: 400,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("J. OTHER with a valid trimmed note creates and persists the trimmed note", async () => {
    const trimmed = "help with the table please";
    const created = csrRequest({
      request_type: "OTHER",
      note: trimmed,
    });
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }), created);
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(
      csrInput({ request_type: "OTHER", note: `   ${trimmed}   ` }),
    )) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request).toEqual(created);
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-e1",
        restaurant_id: "rest-1",
        requested_by: "user-1",
        request_type: "OTHER",
        note: trimmed,
      }),
    );
  });

  it("K. OTHER missing note -> OTHER_NOTE_REQUIRED 400", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(csrInput({ request_type: "OTHER" })),
    ).rejects.toMatchObject({
      code: "OTHER_NOTE_REQUIRED",
      status: 400,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("L. OTHER whitespace-only note -> OTHER_NOTE_REQUIRED 400", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(csrInput({ request_type: "OTHER", note: "     " })),
    ).rejects.toMatchObject({
      code: "OTHER_NOTE_REQUIRED",
      status: 400,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("M. OTHER note over the length cap -> 400 before any insert", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(
        csrInput({
          request_type: "OTHER",
          note: "x".repeat(OTHER_NOTE_MAX_LENGTH + 1),
        }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("N. no staff-assignment lookup or dependency", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "ACTIVE" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(mocks.assignmentGetActive).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("O. no session mutation (transition or create)", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "ACTIVE" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
    expect(mocks.sessionCreate).not.toHaveBeenCalled();
  });

  it("P. eventFacts carries exactly one SERVICE_REQUEST_CREATED fact (D2.5G1)", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_CREATED");
  });

  it("Q. exactly one transaction wraps the whole create", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(port.txCalls).toBe(1);
  });

  it("R. returns the authoritative created DTO untouched", async () => {
    const created = csrRequest({ id: "req-authoritative", note: "extra" });
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }), created);
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(
      csrInput({ request_type: "CALL_STAFF" }),
    )) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
    expect(outcome.value.request).toEqual(created);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------
// D2.5E2 focused tests: acknowledgeServiceRequest boundary.
// Non-locking discovery -> session lock -> request lock -> relationship
// revalidation -> PENDING->ACKNOWLEDGED CAS (status + acknowledged_at +
// acknowledged_by in ONE conditional repository update) -> authoritative DTO +
// one SERVICE_REQUEST_ACKNOWLEDGED event fact (D2.5G2). ACKNOWLEDGED retry is
// idempotent (no CAS / no audit rewrite) -> IDEMPOTENT_NO_MUTATION + eventFacts
// []. COMPLETED/CANCELLED are 409. No session mutation, no assignment
// dependency, no convergence second read. BRING_BILL is acknowledged via the
// normal lifecycle. E3+ (COMPLETE/CANCEL transitions) is not implemented here.
// ------------------------------------------------------------

const asrInput = (
  over: Partial<AcknowledgeServiceRequestInput> = {},
): AcknowledgeServiceRequestInput => ({
  request_id: "req-e2",
  caller_user_id: "staff-1",
  correlation_id: "corr-e2",
  ...over,
});

function asrRequest(over: Partial<ServiceRequestDTO> = {}): ServiceRequestDTO {
  return {
    id: "req-e2",
    session_id: "session-e2",
    restaurant_id: "rest-1",
    requested_by: "user-1",
    request_type: "WATER",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function asrSession(over: Partial<DiningSessionDTO>): DiningSessionDTO {
  return {
    id: "session-e2",
    restaurant_id: "rest-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeAsrPort(over: {
  discovered?: ServiceRequestDTO | null;
  session?: DiningSessionDTO | null;
  lockedRequest?: ServiceRequestDTO | null;
  transition?: TransitionResult<ServiceRequestDTO, ServiceRequestStatus>;
}) {
  const mocks = {
    getById: vi.fn().mockImplementation(async () =>
      over.discovered === undefined ? asrRequest() : over.discovered,
    ),
    sessionLock: vi.fn().mockImplementation(async () =>
      over.session === undefined ? asrSession({}) : over.session,
    ),
    requestLock: vi.fn().mockImplementation(async () =>
      over.lockedRequest === undefined ? asrRequest() : over.lockedRequest,
    ),
    acknowledge: vi.fn().mockImplementation(
      (
        requestId: string,
        acknowledgedBy: string,
        acknowledgedAt: string,
      ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> => {
        if (over.transition) return Promise.resolve(over.transition);
        const base = over.lockedRequest ?? asrRequest();
        return Promise.resolve({
          kind: "UPDATED",
          value: {
            ...base,
            status: "ACKNOWLEDGED",
            acknowledged_by: acknowledgedBy,
            acknowledged_at: acknowledgedAt,
          },
        });
      },
    ),
    sessionTransition: vi.fn(),
    assignmentGetActive: vi.fn(),
  };
  const repos = {
    diningSessions: {
      lockById: mocks.sessionLock,
      transitionStatus: mocks.sessionTransition,
    },
    serviceRequests: {
      getById: mocks.getById,
      lockById: mocks.requestLock,
      acknowledge: mocks.acknowledge,
    },
    staffAssignments: {
      getActiveBySession: mocks.assignmentGetActive,
    },
  } as unknown as DineInTransactionRepos;
  const port = {
    txCalls: 0,
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => {
      port.txCalls += 1;
      return fn(repos);
    },
  };
  return { port, mocks };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("DiningSessionService.acknowledgeServiceRequest boundary (D2.5E2)", () => {
  it("A. PENDING -> ACKNOWLEDGED via one CAS", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("ACKNOWLEDGED");
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("B. CAS uses the locked PENDING request id and the caller actor", async () => {
    const locked = asrRequest({ id: "req-locked", status: "PENDING" });
    const { port, mocks } = makeAsrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(mocks.acknowledge).toHaveBeenCalledWith(
      "req-locked",
      "staff-1",
      expect.stringMatching(ISO_TIMESTAMP),
    );
  });

  it("C. acknowledged_at is a server-generated timestamp", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    const argAt = mocks.acknowledge.mock.calls[0]![2];
    expect(argAt).toMatch(ISO_TIMESTAMP);
    expect(outcome.value.request.acknowledged_at).toBe(argAt);
    expect(outcome.value.request.acknowledged_at).not.toBe(
      outcome.value.request.created_at,
    );
  });

  it("D. acknowledged_by is the caller_user_id", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.acknowledge).toHaveBeenCalledWith(
      "req-e2",
      "staff-1",
      expect.stringMatching(ISO_TIMESTAMP),
    );
    expect(outcome.value.request.acknowledged_by).toBe("staff-1");
  });

  it("E. status + both audit fields are written in the SAME conditional update", async () => {
    // The service issues exactly one repository acknowledge call carrying the
    // status transition source (PENDING) plus acknowledged_at/acknowledged_by;
    // the repository writes all three columns in one conditional UPDATE.
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
    expect(outcome.value.request.status).toBe("ACKNOWLEDGED");
    expect(outcome.value.request.acknowledged_by).toBe("staff-1");
    expect(outcome.value.request.acknowledged_at).toMatch(ISO_TIMESTAMP);
  });

  it("F. UPDATED -> NEW_MUTATION", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
  });

  it("G. returned request is exactly the authoritative transition.value", async () => {
    const authoritative = asrRequest({
      id: "req-authoritative",
      status: "ACKNOWLEDGED",
      acknowledged_by: "staff-1",
      acknowledged_at: "2026-01-01T00:05:00.000Z",
    });
    const { port } = makeAsrPort({
      transition: { kind: "UPDATED", value: authoritative },
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request).toBe(authoritative);
  });

  it("H. eventFacts carries exactly one SERVICE_REQUEST_ACKNOWLEDGED fact (D2.5G2)", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_ACKNOWLEDGED");
  });

  it("I. ACKNOWLEDGED retry -> IDEMPOTENT_NO_MUTATION", async () => {
    const locked = asrRequest({
      status: "ACKNOWLEDGED",
      acknowledged_by: "staff-1",
      acknowledged_at: "2026-01-01T00:01:00.000Z",
    });
    const { port, mocks } = makeAsrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.request).toBe(locked);
  });

  it("J. retry issues no CAS and no audit rewrite", async () => {
    const locked = asrRequest({
      status: "ACKNOWLEDGED",
      acknowledged_by: "staff-9",
      acknowledged_at: "2026-01-01T00:01:00.000Z",
    });
    const { port, mocks } = makeAsrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
    expect(outcome.value.request.acknowledged_by).toBe("staff-9");
    expect(outcome.value.request.acknowledged_at).toBe("2026-01-01T00:01:00.000Z");
  });

  it("K. COMPLETED -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeAsrPort({
      lockedRequest: asrRequest({ status: "COMPLETED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("L. CANCELLED -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeAsrPort({
      lockedRequest: asrRequest({ status: "CANCELLED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("M. CAS NOT_FOUND -> SERVICE_REQUEST_NOT_FOUND 404", async () => {
    const { port, mocks } = makeAsrPort({
      transition: { kind: "NOT_FOUND" },
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
      status: 404,
    });
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("N. CAS STATE_MISMATCH -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeAsrPort({
      transition: { kind: "STATE_MISMATCH", current: "COMPLETED" },
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("O. no convergence second read after the CAS", async () => {
    // Discovery read once, request lock once, CAS once — the service never
    // re-reads after the conditional update to converge a result.
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(mocks.getById).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
    const order = [
      mocks.getById.mock.invocationCallOrder[0],
      mocks.sessionLock.mock.invocationCallOrder[0],
      mocks.requestLock.mock.invocationCallOrder[0],
      mocks.acknowledge.mock.invocationCallOrder[0],
    ];
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
    expect(order[2]!).toBeLessThan(order[3]!);
  });

  it("P. canonical lock order is session then request", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(mocks.sessionLock).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.sessionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestLock.mock.invocationCallOrder[0]!,
    );
  });

  it("Q. session/request relationship mismatch -> INTERNAL_ERROR 500", async () => {
    const { port, mocks } = makeAsrPort({
      lockedRequest: asrRequest({ session_id: "session-other" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("R. no staff-assignment lookup or dependency", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(mocks.assignmentGetActive).not.toHaveBeenCalled();
  });

  it("S. no session mutation", async () => {
    const { port, mocks } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
  });

  it("T. BRING_BILL PENDING may be acknowledged via the normal lifecycle", async () => {
    const { port, mocks } = makeAsrPort({
      lockedRequest: asrRequest({ request_type: "BRING_BILL", status: "PENDING" }),
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.request_type).toBe("BRING_BILL");
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("U. exactly one transaction wraps the whole acknowledge", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(port.txCalls).toBe(1);
  });

  it("V. missing discovered request -> SERVICE_REQUEST_NOT_FOUND 404", async () => {
    const { port, mocks } = makeAsrPort({ discovered: null });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
      status: 404,
    });
    expect(mocks.sessionLock).not.toHaveBeenCalled();
    expect(mocks.requestLock).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("W. missing locked session -> INTERNAL_ERROR 500", async () => {
    const { port, mocks } = makeAsrPort({ session: null });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("X. missing locked request -> SERVICE_REQUEST_NOT_FOUND 404", async () => {
    const { port, mocks } = makeAsrPort({ lockedRequest: null });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
      status: 404,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// D2.5E3 focused tests: completeServiceRequest boundary.
// Non-locking discovery -> session lock -> request lock -> relationship
// revalidation -> ACKNOWLEDGED->COMPLETED CAS (status + completed_at +
// completed_by in ONE conditional repository update) -> authoritative DTO +
// one SERVICE_REQUEST_COMPLETED event fact (D2.5G3). COMPLETED retry is
// idempotent (no CAS / no audit rewrite) -> IDEMPOTENT_NO_MUTATION + eventFacts
// []. PENDING and CANCELLED are 409 — PENDING is NEVER silently
// auto-acknowledged. No session mutation, no assignment dependency, no
// convergence second read. BRING_BILL completes via the normal lifecycle.
// E4+ (CANCEL) not here.
// ------------------------------------------------------------

const cmrInput = (
  over: Partial<CompleteServiceRequestInput> = {},
): CompleteServiceRequestInput => ({
  request_id: "req-e3",
  caller_user_id: "staff-2",
  correlation_id: "corr-e3",
  ...over,
});

function cmrRequest(over: Partial<ServiceRequestDTO> = {}): ServiceRequestDTO {
  return {
    id: "req-e3",
    session_id: "session-e3",
    restaurant_id: "rest-1",
    requested_by: "user-1",
    request_type: "WATER",
    status: "ACKNOWLEDGED",
    note: null,
    acknowledged_by: "staff-1",
    acknowledged_at: "2026-01-01T00:01:00.000Z",
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    ...over,
  };
}

function cmrSession(over: Partial<DiningSessionDTO>): DiningSessionDTO {
  return {
    id: "session-e3",
    restaurant_id: "rest-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeCmrPort(over: {
  discovered?: ServiceRequestDTO | null;
  session?: DiningSessionDTO | null;
  lockedRequest?: ServiceRequestDTO | null;
  transition?: TransitionResult<ServiceRequestDTO, ServiceRequestStatus>;
}) {
  const mocks = {
    getById: vi.fn().mockImplementation(async () =>
      over.discovered === undefined ? cmrRequest() : over.discovered,
    ),
    sessionLock: vi.fn().mockImplementation(async () =>
      over.session === undefined ? cmrSession({}) : over.session,
    ),
    requestLock: vi.fn().mockImplementation(async () =>
      over.lockedRequest === undefined ? cmrRequest() : over.lockedRequest,
    ),
    complete: vi.fn().mockImplementation(
      (
        requestId: string,
        completedBy: string,
        completedAt: string,
      ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> => {
        if (over.transition) return Promise.resolve(over.transition);
        const base = over.lockedRequest ?? cmrRequest();
        return Promise.resolve({
          kind: "UPDATED",
          value: {
            ...base,
            status: "COMPLETED",
            completed_by: completedBy,
            completed_at: completedAt,
          },
        });
      },
    ),
    sessionTransition: vi.fn(),
    assignmentGetActive: vi.fn(),
  };
  const repos = {
    diningSessions: {
      lockById: mocks.sessionLock,
      transitionStatus: mocks.sessionTransition,
    },
    serviceRequests: {
      getById: mocks.getById,
      lockById: mocks.requestLock,
      complete: mocks.complete,
    },
    staffAssignments: {
      getActiveBySession: mocks.assignmentGetActive,
    },
  } as unknown as DineInTransactionRepos;
  const port = {
    txCalls: 0,
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => {
      port.txCalls += 1;
      return fn(repos);
    },
  };
  return { port, mocks };
}

describe("DiningSessionService.completeServiceRequest boundary (D2.5E3)", () => {
  it("A. ACKNOWLEDGED -> COMPLETED via one CAS", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("COMPLETED");
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("B. CAS uses the locked ACKNOWLEDGED request id and the caller actor", async () => {
    const locked = cmrRequest({ id: "req-locked", status: "ACKNOWLEDGED" });
    const { port, mocks } = makeCmrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(mocks.complete).toHaveBeenCalledWith(
      "req-locked",
      "staff-2",
      expect.stringMatching(ISO_TIMESTAMP),
    );
  });

  it("C. completed_at is a server-generated timestamp", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    const argAt = mocks.complete.mock.calls[0]![2];
    expect(argAt).toMatch(ISO_TIMESTAMP);
    expect(outcome.value.request.completed_at).toBe(argAt);
    expect(outcome.value.request.completed_at).not.toBe(
      outcome.value.request.created_at,
    );
  });

  it("D. completed_by is the caller_user_id", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.complete).toHaveBeenCalledWith(
      "req-e3",
      "staff-2",
      expect.stringMatching(ISO_TIMESTAMP),
    );
    expect(outcome.value.request.completed_by).toBe("staff-2");
  });

  it("E. status + both audit fields are written in the SAME conditional update", async () => {
    // The service issues exactly one repository complete call carrying the
    // status transition source (ACKNOWLEDGED) plus completed_at/completed_by;
    // the repository writes all three columns in one conditional UPDATE.
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(outcome.value.request.status).toBe("COMPLETED");
    expect(outcome.value.request.completed_by).toBe("staff-2");
    expect(outcome.value.request.completed_at).toMatch(ISO_TIMESTAMP);
  });

  it("F. UPDATED -> NEW_MUTATION", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
  });

  it("G. returned request is exactly the authoritative transition.value", async () => {
    const authoritative = cmrRequest({
      id: "req-authoritative",
      status: "COMPLETED",
      completed_by: "staff-2",
      completed_at: "2026-01-01T00:06:00.000Z",
    });
    const { port } = makeCmrPort({
      transition: { kind: "UPDATED", value: authoritative },
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request).toBe(authoritative);
  });

  it("H. eventFacts carries exactly one SERVICE_REQUEST_COMPLETED fact (D2.5G3)", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_COMPLETED");
  });

  it("I. COMPLETED retry -> IDEMPOTENT_NO_MUTATION", async () => {
    const locked = cmrRequest({
      status: "COMPLETED",
      completed_by: "staff-2",
      completed_at: "2026-01-01T00:02:00.000Z",
    });
    const { port, mocks } = makeCmrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.request).toBe(locked);
  });

  it("J. retry issues no CAS and no audit rewrite", async () => {
    const locked = cmrRequest({
      status: "COMPLETED",
      completed_by: "staff-9",
      completed_at: "2026-01-01T00:02:00.000Z",
    });
    const { port, mocks } = makeCmrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
    expect(outcome.value.request.completed_by).toBe("staff-9");
    expect(outcome.value.request.completed_at).toBe("2026-01-01T00:02:00.000Z");
  });

  it("K. PENDING -> INVALID_SERVICE_REQUEST_TRANSITION 409 (never auto-acknowledged)", async () => {
    const { port, mocks } = makeCmrPort({
      lockedRequest: cmrRequest({ status: "PENDING" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("L. CANCELLED -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeCmrPort({
      lockedRequest: cmrRequest({ status: "CANCELLED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("M. CAS NOT_FOUND -> SERVICE_REQUEST_NOT_FOUND 404", async () => {
    const { port, mocks } = makeCmrPort({
      transition: { kind: "NOT_FOUND" },
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
      status: 404,
    });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("N. CAS STATE_MISMATCH -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeCmrPort({
      transition: { kind: "STATE_MISMATCH", current: "PENDING" },
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("O. no convergence second read after the CAS", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(mocks.getById).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const order = [
      mocks.getById.mock.invocationCallOrder[0],
      mocks.sessionLock.mock.invocationCallOrder[0],
      mocks.requestLock.mock.invocationCallOrder[0],
      mocks.complete.mock.invocationCallOrder[0],
    ];
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
    expect(order[2]!).toBeLessThan(order[3]!);
  });

  it("P. canonical lock order is session then request", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(mocks.sessionLock).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.sessionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestLock.mock.invocationCallOrder[0]!,
    );
  });

  it("Q. session/request relationship mismatch -> INTERNAL_ERROR 500", async () => {
    const { port, mocks } = makeCmrPort({
      lockedRequest: cmrRequest({ session_id: "session-other" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("R. no staff-assignment lookup or dependency", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(mocks.assignmentGetActive).not.toHaveBeenCalled();
  });

  it("S. no session mutation", async () => {
    const { port, mocks } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
  });

  it("T. BRING_BILL ACKNOWLEDGED may complete via the normal lifecycle", async () => {
    const { port, mocks } = makeCmrPort({
      lockedRequest: cmrRequest({
        request_type: "BRING_BILL",
        status: "ACKNOWLEDGED",
      }),
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.request_type).toBe("BRING_BILL");
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("U. exactly one transaction wraps the whole complete", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(port.txCalls).toBe(1);
  });
});

// ------------------------------------------------------------
// D2.5E4 focused tests: cancelServiceRequest boundary.
// Non-locking discovery -> session lock -> request lock -> relationship
// revalidation -> BRING_BILL special boundary (wins over every state) ->
// CANCELLED idempotent / COMPLETED 409 / PENDING|ACKNOWLEDGED CAS
// (status + cancelled_at + cancelled_by in ONE conditional repository update)
// -> authoritative DTO + one SERVICE_REQUEST_CANCELLED event fact (D2.5G4).
// CANCELLED retry -> IDEMPOTENT_NO_MUTATION + eventFacts []. No session
// mutation, no assignment lookup, no bill/payment side effects, no convergence
// second read. E5+ (event wiring) partially here (G4); COMPLETED/ACK/CREATED
// events live in their own blocks.
// ------------------------------------------------------------

const cnrInput = (
  over: Partial<CancelServiceRequestInput> = {},
): CancelServiceRequestInput => ({
  request_id: "req-e4",
  caller_user_id: "user-1",
  correlation_id: "corr-e4",
  ...over,
});

function cnrRequest(over: Partial<ServiceRequestDTO> = {}): ServiceRequestDTO {
  return {
    id: "req-e4",
    session_id: "session-e4",
    restaurant_id: "rest-1",
    requested_by: "user-1",
    request_type: "WATER",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function cnrSession(over: Partial<DiningSessionDTO>): DiningSessionDTO {
  return {
    id: "session-e4",
    restaurant_id: "rest-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeCnrPort(over: {
  discovered?: ServiceRequestDTO | null;
  session?: DiningSessionDTO | null;
  lockedRequest?: ServiceRequestDTO | null;
  transition?: TransitionResult<ServiceRequestDTO, ServiceRequestStatus>;
}) {
  const mocks = {
    getById: vi.fn().mockImplementation(async () =>
      over.discovered === undefined ? cnrRequest() : over.discovered,
    ),
    sessionLock: vi.fn().mockImplementation(async () =>
      over.session === undefined ? cnrSession({}) : over.session,
    ),
    requestLock: vi.fn().mockImplementation(async () =>
      over.lockedRequest === undefined ? cnrRequest() : over.lockedRequest,
    ),
    cancel: vi.fn().mockImplementation(
      (
        requestId: string,
        cancelledBy: string,
        cancelledAt: string,
      ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> => {
        if (over.transition) return Promise.resolve(over.transition);
        const base = over.lockedRequest ?? cnrRequest();
        return Promise.resolve({
          kind: "UPDATED",
          value: {
            ...base,
            status: "CANCELLED",
            cancelled_by: cancelledBy,
            cancelled_at: cancelledAt,
          },
        });
      },
    ),
    sessionTransition: vi.fn(),
    assignmentGetActive: vi.fn(),
    billGetBySessionId: vi.fn(),
  };
  const repos = {
    diningSessions: {
      lockById: mocks.sessionLock,
      transitionStatus: mocks.sessionTransition,
    },
    serviceRequests: {
      getById: mocks.getById,
      lockById: mocks.requestLock,
      cancel: mocks.cancel,
    },
    staffAssignments: {
      getActiveBySession: mocks.assignmentGetActive,
    },
    sessionBills: {
      getBySessionId: mocks.billGetBySessionId,
    },
  } as unknown as DineInTransactionRepos;
  const port = {
    txCalls: 0,
    runInTransaction: async <T>(
      fn: (r: DineInTransactionRepos) => Promise<T>,
    ): Promise<T> => {
      port.txCalls += 1;
      return fn(repos);
    },
  };
  return { port, mocks };
}

describe("DiningSessionService.cancelServiceRequest boundary (D2.5E4)", () => {
  it("A. PENDING -> CANCELLED via one CAS", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("CANCELLED");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it("B. ACKNOWLEDGED -> CANCELLED via one CAS", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({ status: "ACKNOWLEDGED" }),
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("CANCELLED");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it("C. CAS uses the locked PENDING request id + caller actor", async () => {
    const locked = cnrRequest({ id: "req-locked", status: "PENDING" });
    const { port, mocks } = makeCnrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.cancel).toHaveBeenCalledWith(
      "req-locked",
      "user-1",
      expect.stringMatching(ISO_TIMESTAMP),
    );
  });

  it("D. CAS uses the locked ACKNOWLEDGED request id + caller actor", async () => {
    const locked = cnrRequest({ id: "req-locked", status: "ACKNOWLEDGED" });
    const { port, mocks } = makeCnrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.cancel).toHaveBeenCalledWith(
      "req-locked",
      "user-1",
      expect.stringMatching(ISO_TIMESTAMP),
    );
  });

  it("E. cancelled_at is a server-generated timestamp", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    const argAt = mocks.cancel.mock.calls[0]![2];
    expect(argAt).toMatch(ISO_TIMESTAMP);
    expect(outcome.value.request.cancelled_at).toBe(argAt);
    expect(outcome.value.request.cancelled_at).not.toBe(
      outcome.value.request.created_at,
    );
  });

  it("F. cancelled_by is the caller_user_id", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.cancel).toHaveBeenCalledWith(
      "req-e4",
      "user-1",
      expect.stringMatching(ISO_TIMESTAMP),
    );
    expect(outcome.value.request.cancelled_by).toBe("user-1");
  });

  it("G. status + both audit fields are written in the SAME conditional update", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(outcome.value.request.status).toBe("CANCELLED");
    expect(outcome.value.request.cancelled_by).toBe("user-1");
    expect(outcome.value.request.cancelled_at).toMatch(ISO_TIMESTAMP);
  });

  it("H. UPDATED -> NEW_MUTATION", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
  });

  it("I. returned request is exactly the authoritative transition.value", async () => {
    const authoritative = cnrRequest({
      id: "req-authoritative",
      status: "CANCELLED",
      cancelled_by: "user-1",
      cancelled_at: "2026-01-01T00:07:00.000Z",
    });
    const { port } = makeCnrPort({
      transition: { kind: "UPDATED", value: authoritative },
    });
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request).toBe(authoritative);
  });

  it("J. eventFacts carries exactly one SERVICE_REQUEST_CANCELLED fact (D2.5G4)", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_CANCELLED");
  });

  it("K. CANCELLED retry -> IDEMPOTENT_NO_MUTATION", async () => {
    const locked = cnrRequest({
      status: "CANCELLED",
      cancelled_by: "user-1",
      cancelled_at: "2026-01-01T00:02:00.000Z",
    });
    const { port, mocks } = makeCnrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.value.request).toBe(locked);
  });

  it("L. retry issues no CAS and no audit rewrite", async () => {
    const locked = cnrRequest({
      status: "CANCELLED",
      cancelled_by: "user-9",
      cancelled_at: "2026-01-01T00:02:00.000Z",
    });
    const { port, mocks } = makeCnrPort({ lockedRequest: locked });
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
    expect(outcome.value.request.cancelled_by).toBe("user-9");
    expect(outcome.value.request.cancelled_at).toBe("2026-01-01T00:02:00.000Z");
  });

  it("M. COMPLETED -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({ status: "COMPLETED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("N. BRING_BILL PENDING -> BRING_BILL_MANAGED_BY_BILL_FLOW 409", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({ request_type: "BRING_BILL", status: "PENDING" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
      status: 409,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("O. BRING_BILL ACKNOWLEDGED -> BRING_BILL_MANAGED_BY_BILL_FLOW 409", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({
        request_type: "BRING_BILL",
        status: "ACKNOWLEDGED",
      }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
      status: 409,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("P. BRING_BILL CANCELLED -> 409, never a generic idempotent success", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({
        request_type: "BRING_BILL",
        status: "CANCELLED",
        cancelled_by: "user-1",
        cancelled_at: "2026-01-01T00:02:00.000Z",
      }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
      status: 409,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("Q. CAS NOT_FOUND -> SERVICE_REQUEST_NOT_FOUND 404", async () => {
    const { port, mocks } = makeCnrPort({
      transition: { kind: "NOT_FOUND" },
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
      status: 404,
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it("R. CAS STATE_MISMATCH -> INVALID_SERVICE_REQUEST_TRANSITION 409", async () => {
    const { port, mocks } = makeCnrPort({
      transition: { kind: "STATE_MISMATCH", current: "COMPLETED" },
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
      status: 409,
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it("S. no convergence second read after the CAS", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.getById).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const order = [
      mocks.getById.mock.invocationCallOrder[0],
      mocks.sessionLock.mock.invocationCallOrder[0],
      mocks.requestLock.mock.invocationCallOrder[0],
      mocks.cancel.mock.invocationCallOrder[0],
    ];
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
    expect(order[2]!).toBeLessThan(order[3]!);
  });

  it("T. canonical lock order is session then request", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.sessionLock).toHaveBeenCalledTimes(1);
    expect(mocks.requestLock).toHaveBeenCalledTimes(1);
    expect(mocks.sessionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestLock.mock.invocationCallOrder[0]!,
    );
  });

  it("U. session/request relationship mismatch -> INTERNAL_ERROR 500", async () => {
    const { port, mocks } = makeCnrPort({
      lockedRequest: cnrRequest({ session_id: "session-other" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("V. no staff-assignment lookup or dependency", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.assignmentGetActive).not.toHaveBeenCalled();
  });

  it("W. no session mutation", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
  });

  it("X. no bill/payment side effects", async () => {
    const { port, mocks } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(mocks.billGetBySessionId).not.toHaveBeenCalled();
    expect(mocks.sessionTransition).not.toHaveBeenCalled();
    expect(mocks.assignmentGetActive).not.toHaveBeenCalled();
  });

  it("Y. exactly one transaction wraps the whole cancel", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(port.txCalls).toBe(1);
  });
});

// ------------------------------------------------------------
// D2.5G1 focused tests: SERVICE_REQUEST_CREATED event emission for generic
// createServiceRequest. The committed NEW_MUTATION carries exactly one
// SERVICE_REQUEST_CREATED fact; emission is strictly post-commit and
// best-effort (a failure never fails the committed create). ACK/COMPLETE/
// CANCEL events are NOT implemented here. Rejection paths emit nothing.
// ------------------------------------------------------------

describe("DiningSessionService SERVICE_REQUEST_CREATED emission (D2.5G1)", () => {
  beforeEach(() => {
    vi.mocked(emitDineInEventFactsBestEffort).mockClear();
  });

  it("A. successful WATER create emits exactly one SERVICE_REQUEST_CREATED event", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_CREATED");
  });

  it("B. successful OTHER create emits one event", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(
      csrInput({ request_type: "OTHER", note: "extra plates please" }),
    );
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_CREATED");
  });

  it("C. aggregate id is the created request id", async () => {
    const created = csrRequest({ id: "req-aggregate" });
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }), created);
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(
      csrInput({ request_type: "CALL_STAFF" }),
    )) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toMatchObject({ request_id: "req-aggregate" });
    expect(outcome.value.request.id).toBe("req-aggregate");
  });

  it("D. correlation_id is preserved into the emitter call", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput({ correlation_id: "corr-g1" }));
    const [, correlationId] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(correlationId).toBe("corr-g1");
  });

  it("E. payload is minimal and accepted (no note/body/PII/table token)", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(
      csrInput({ request_type: "OTHER", note: "sensitive customer note" }),
    );
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    // The fact derives from the authoritative created DTO (WATER in the port
    // fixture); the OTHER/note input is deliberately NOT echoed into the fact.
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_CREATED",
      request_id: "req-e1",
      session_id: "session-e1",
      restaurant_id: "rest-1",
      request_type: "WATER",
      request_status: "PENDING",
    });
  });

  it("F. emission happens only AFTER the transaction callback resolves", async () => {
    const order: string[] = [];
    const created = csrRequest({ id: "req-g1" });
    const repos = {
      diningSessions: {
        lockById: vi.fn().mockResolvedValue(csrSession({ status: "OPEN" })),
      },
      serviceRequests: {
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        order.push("tx-callback-start");
        const result = await fn(repos);
        order.push("tx-callback-end");
        return result;
      },
    };
    vi.mocked(emitDineInEventFactsBestEffort).mockImplementation(async () => {
      order.push("emit");
    });
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(order.indexOf("tx-callback-end")).toBeLessThan(order.indexOf("emit"));
    expect(order.filter((e) => e === "emit")).toHaveLength(1);
  });

  it("G. emission failure does NOT fail the committed create result", async () => {
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }));
    vi.mocked(emitDineInEventFactsBestEffort).mockRejectedValue(
      new Error("bus down"),
    );
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("PENDING");
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
  });

  it("H. CLOSED-session rejection emits nothing", async () => {
    const { port } = makeCsrPort(csrSession({ status: "CLOSED" }));
    const service = new DiningSessionService(port);
    await expect(service.createServiceRequest(csrInput())).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_REQUEST",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("I. BRING_BILL rejection emits nothing", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(csrInput({ request_type: "BRING_BILL" })),
    ).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("J. invalid-type rejection emits nothing", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(
        csrInput({ request_type: "FLAMINGO" as unknown as CreateServiceRequestInput["request_type"] }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST_TYPE" });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("K. OTHER validation rejection emits nothing", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await expect(
      service.createServiceRequest(csrInput({ request_type: "OTHER" })),
    ).rejects.toMatchObject({ code: "OTHER_NOTE_REQUIRED" });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("L. exactly one event per successful create", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    await service.createServiceRequest(csrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
  });

  it("M. no ACK/COMPLETE/CANCEL event is added", async () => {
    const { port } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(csrInput())) as MutationOutcome<
      CreateServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts.every((f) => f.kind === "SERVICE_REQUEST_CREATED")).toBe(
      true,
    );
  });

  it("N. create persistence semantics are unchanged", async () => {
    const created = csrRequest({ id: "req-authoritative", note: "extra" });
    const { port, mocks } = makeCsrPort(csrSession({ status: "OPEN" }), created);
    const service = new DiningSessionService(port);
    const outcome = (await service.createServiceRequest(
      csrInput({ request_type: "CALL_STAFF" }),
    )) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
    expect(outcome.value.request).toEqual(created);
    expect(mocks.createRequest).toHaveBeenCalledWith({
      session_id: "session-e1",
      restaurant_id: "rest-1",
      requested_by: "user-1",
      request_type: "CALL_STAFF",
      note: null,
    });
  });
});

// ------------------------------------------------------------
// D2.5G2 focused tests: SERVICE_REQUEST_ACKNOWLEDGED event emission for
// acknowledgeServiceRequest. The committed PENDING->ACKNOWLEDGED NEW_MUTATION
// carries exactly one SERVICE_REQUEST_ACKNOWLEDGED fact; emission is strictly
// post-commit and best-effort (a failure never fails the committed ack). An
// ACKNOWLEDGED idempotent retry emits NOTHING (IDEMPOTENT_NO_MUTATION +
// eventFacts []). COMPLETED/CANCELLED events are NOT implemented here and no
// ack path ever emits one. Rejection paths emit nothing.
// ------------------------------------------------------------

describe("DiningSessionService SERVICE_REQUEST_ACKNOWLEDGED emission (D2.5G2)", () => {
  beforeEach(() => {
    // mockReset clears call history AND any mockImplementation/mockRejectedValue
    // leaked from the G1 emission-failure test, keeping the default mock
    // resolve-undefined semantics for every G2 test.
    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
  });

  it("A. successful PENDING -> ACKNOWLEDGED emits exactly one SERVICE_REQUEST_ACKNOWLEDGED event", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_ACKNOWLEDGED");
  });

  it("B. outcome.eventFacts carries exactly one SERVICE_REQUEST_ACKNOWLEDGED fact", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_ACKNOWLEDGED");
  });

  it("C. aggregate id is the acknowledged request id", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toMatchObject({ request_id: "req-e2" });
    expect(outcome.value.request.id).toBe("req-e2");
  });

  it("D. correlation_id is preserved into the emitter call", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput({ correlation_id: "corr-g2" }));
    const [, correlationId] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(correlationId).toBe("corr-g2");
  });

  it("E. payload is minimal and derives from the authoritative DTO (no note/PII/table token)", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput({ request_id: "ignored-by-fact" }));
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    // The fact derives from the authoritative committed transition DTO, never
    // from the input. The fixture's DTO is WATER/ACKNOWLEDGED/req-e2 regardless
    // of the request_id in the input.
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_ACKNOWLEDGED",
      request_id: "req-e2",
      session_id: "session-e2",
      restaurant_id: "rest-1",
      request_type: "WATER",
      request_status: "ACKNOWLEDGED",
    });
  });

  it("F. emission happens only AFTER the transaction callback resolves", async () => {
    const order: string[] = [];
    const repos = {
      diningSessions: {
        lockById: vi.fn().mockResolvedValue(asrSession({})),
      },
      serviceRequests: {
        getById: vi.fn().mockResolvedValue(asrRequest()),
        lockById: vi.fn().mockResolvedValue(asrRequest()),
        acknowledge: vi.fn().mockResolvedValue({
          kind: "UPDATED",
          value: asrRequest({ status: "ACKNOWLEDGED" }),
        }),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        order.push("tx-callback-start");
        const result = await fn(repos);
        order.push("tx-callback-end");
        return result;
      },
    };
    vi.mocked(emitDineInEventFactsBestEffort).mockImplementation(async () => {
      order.push("emit");
    });
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput());
    expect(order.indexOf("tx-callback-end")).toBeLessThan(order.indexOf("emit"));
    expect(order.filter((e) => e === "emit")).toHaveLength(1);
  });

  it("G. emission failure does NOT fail the committed acknowledge result", async () => {
    const { port } = makeAsrPort({});
    vi.mocked(emitDineInEventFactsBestEffort).mockRejectedValue(
      new Error("bus down"),
    );
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("ACKNOWLEDGED");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
  });

  it("H. ACKNOWLEDGED idempotent retry emits NOTHING", async () => {
    const { port } = makeAsrPort({ lockedRequest: asrRequest({ status: "ACKNOWLEDGED" }) });
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.eventFacts).toEqual([]);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("I. COMPLETED/CANCELLED 409 rejection emits nothing", async () => {
    const { port } = makeAsrPort({ lockedRequest: asrRequest({ status: "COMPLETED" }) });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("J. NOT_FOUND rejection emits nothing", async () => {
    const { port } = makeAsrPort({ discovered: null });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("K. STATE_MISMATCH rejection emits nothing", async () => {
    const { port } = makeAsrPort({
      transition: { kind: "STATE_MISMATCH", current: "COMPLETED" },
    });
    const service = new DiningSessionService(port);
    await expect(service.acknowledgeServiceRequest(asrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("L. no COMPLETED/CANCELLED event is ever emitted by ack", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(asrInput())) as MutationOutcome<
      AcknowledgeServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts.every((f) => f.kind === "SERVICE_REQUEST_ACKNOWLEDGED")).toBe(
      true,
    );
  });

  it("M. mapper maps the ACKNOWLEDGED fact to a ServiceRequestAcknowledged envelope", async () => {
    const { port } = makeAsrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.acknowledgeServiceRequest(
      asrInput({ correlation_id: "corr-g2-mapper" }),
    )) as MutationOutcome<AcknowledgeServiceRequestResult, DineInEventFact>;
    const descriptor = mapDineInEventFact(outcome.eventFacts[0]!, "corr-g2-mapper");
    expect(descriptor).toEqual({
      event_name: "ServiceRequestAcknowledged",
      aggregate_id: "req-e2",
      payload: {
        restaurant_id: "rest-1",
        session_id: "session-e2",
        request_type: "WATER",
        request_status: "ACKNOWLEDGED",
      },
      metadata: { correlation_id: "corr-g2-mapper" },
    });
  });

  it("N. authoritative committed DTO drives the fact, not the input", async () => {
    const committed = asrRequest({
      id: "req-authoritative",
      session_id: "session-authoritative",
      request_type: "CALL_STAFF",
    });
    const { port } = makeAsrPort({
      transition: { kind: "UPDATED", value: committed },
    });
    const service = new DiningSessionService(port);
    await service.acknowledgeServiceRequest(asrInput({ request_id: "req-input" }));
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_ACKNOWLEDGED",
      request_id: "req-authoritative",
      session_id: "session-authoritative",
      restaurant_id: "rest-1",
      request_type: "CALL_STAFF",
      request_status: "PENDING",
    });
  });
});

// ------------------------------------------------------------
// D2.5G3 focused tests: SERVICE_REQUEST_COMPLETED event emission for
// completeServiceRequest. The committed ACKNOWLEDGED->COMPLETED NEW_MUTATION
// carries exactly one SERVICE_REQUEST_COMPLETED fact; emission is strictly
// post-commit and best-effort (a failure never fails the committed completion).
// A COMPLETED idempotent retry emits NOTHING (IDEMPOTENT_NO_MUTATION +
// eventFacts []). CANCELLED events are NOT implemented here and no complete
// path ever emits one. Rejection paths emit nothing. BRING_BILL completes via
// the normal lifecycle and emits the same COMPLETED event.
// ------------------------------------------------------------

describe("DiningSessionService SERVICE_REQUEST_COMPLETED emission (D2.5G3)", () => {
  beforeEach(() => {
    // mockReset clears call history AND any mockImplementation/mockRejectedValue
    // leaked from earlier emission-failure tests, keeping the default mock
    // resolve-undefined semantics for every G3 test.
    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
  });

  it("A. ACKNOWLEDGED -> COMPLETED emits exactly one SERVICE_REQUEST_COMPLETED event", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_COMPLETED");
  });

  it("B. outcome.eventFacts carries exactly one SERVICE_REQUEST_COMPLETED fact", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts[0]!.kind).toBe("SERVICE_REQUEST_COMPLETED");
  });

  it("C. aggregate id is the completed request id", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toMatchObject({ request_id: "req-e3" });
    expect(outcome.value.request.id).toBe("req-e3");
  });

  it("D. correlation_id is preserved into the emitter call", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput({ correlation_id: "corr-g3" }));
    const [, correlationId] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(correlationId).toBe("corr-g3");
  });

  it("E. payload is minimal and derives from the authoritative DTO (no note/PII/table token)", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput({ request_id: "ignored-by-fact" }));
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    // The fact derives from the authoritative committed transition DTO, never
    // from the input. The fixture's DTO is WATER/COMPLETED/req-e3 regardless of
    // the request_id in the input. No completed_by/completed_at, no note.
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_COMPLETED",
      request_id: "req-e3",
      session_id: "session-e3",
      restaurant_id: "rest-1",
      request_type: "WATER",
      request_status: "COMPLETED",
    });
  });

  it("F. emission happens only AFTER the transaction callback resolves", async () => {
    const order: string[] = [];
    const repos = {
      diningSessions: {
        lockById: vi.fn().mockResolvedValue(cmrSession({})),
      },
      serviceRequests: {
        getById: vi.fn().mockResolvedValue(cmrRequest()),
        lockById: vi.fn().mockResolvedValue(cmrRequest()),
        complete: vi.fn().mockResolvedValue({
          kind: "UPDATED",
          value: cmrRequest({ status: "COMPLETED" }),
        }),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        order.push("tx-callback-start");
        const result = await fn(repos);
        order.push("tx-callback-end");
        return result;
      },
    };
    vi.mocked(emitDineInEventFactsBestEffort).mockImplementation(async () => {
      order.push("emit");
    });
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(order.indexOf("tx-callback-end")).toBeLessThan(order.indexOf("emit"));
    expect(order.filter((e) => e === "emit")).toHaveLength(1);
  });

  it("G. emission failure does NOT fail the committed completion result", async () => {
    const { port } = makeCmrPort({});
    vi.mocked(emitDineInEventFactsBestEffort).mockRejectedValue(
      new Error("bus down"),
    );
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("COMPLETED");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
  });

  it("H. COMPLETED idempotent retry emits NOTHING", async () => {
    const { port } = makeCmrPort({ lockedRequest: cmrRequest({ status: "COMPLETED" }) });
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.eventFacts).toEqual([]);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("I. PENDING 409 rejection emits nothing", async () => {
    const { port } = makeCmrPort({ lockedRequest: cmrRequest({ status: "PENDING" }) });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("J. CANCELLED 409 rejection emits nothing", async () => {
    const { port } = makeCmrPort({ lockedRequest: cmrRequest({ status: "CANCELLED" }) });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("K. CAS NOT_FOUND rejection emits nothing", async () => {
    const { port } = makeCmrPort({ transition: { kind: "NOT_FOUND" } });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("L. CAS STATE_MISMATCH rejection emits nothing", async () => {
    const { port } = makeCmrPort({
      transition: { kind: "STATE_MISMATCH", current: "PENDING" },
    });
    const service = new DiningSessionService(port);
    await expect(service.completeServiceRequest(cmrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("M. BRING_BILL ACKNOWLEDGED -> COMPLETED emits the same COMPLETED event", async () => {
    const { port } = makeCmrPort({
      lockedRequest: cmrRequest({ request_type: "BRING_BILL" }),
    });
    const service = new DiningSessionService(port);
    await service.completeServiceRequest(cmrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_COMPLETED",
      request_id: "req-e3",
      session_id: "session-e3",
      restaurant_id: "rest-1",
      request_type: "BRING_BILL",
      request_status: "COMPLETED",
    });
  });

  it("N. CREATED and ACKNOWLEDGED event behavior is unchanged", async () => {
    const { port: csrPort } = makeCsrPort(csrSession({ status: "OPEN" }));
    const service = new DiningSessionService(csrPort);
    await service.createServiceRequest(csrInput());
    const [createFacts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(createFacts[0]!.kind).toBe("SERVICE_REQUEST_CREATED");
    expect(createFacts).toHaveLength(1);

    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
    const { port: asrPort } = makeAsrPort({});
    const ackService = new DiningSessionService(asrPort);
    await ackService.acknowledgeServiceRequest(asrInput());
    const [ackFacts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(ackFacts[0]!.kind).toBe("SERVICE_REQUEST_ACKNOWLEDGED");
    expect(ackFacts).toHaveLength(1);
  });

  it("O. no CANCELLED event is ever emitted by complete", async () => {
    const { port } = makeCmrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.completeServiceRequest(cmrInput())) as MutationOutcome<
      CompleteServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts.every((f) => f.kind === "SERVICE_REQUEST_COMPLETED")).toBe(
      true,
    );
  });
});

// ------------------------------------------------------------
// D2.5G4 focused tests: SERVICE_REQUEST_CANCELLED event emission for generic
// cancelServiceRequest. A committed PENDING->CANCELLED or ACKNOWLEDGED->CANCELLED
// NEW_MUTATION carries exactly one SERVICE_REQUEST_CANCELLED fact; emission is
// strictly post-commit and best-effort (a failure never fails the committed
// cancellation). A CANCELLED idempotent retry emits NOTHING. The BRING_BILL 409
// boundary wins over EVERY lifecycle state, so BRING_BILL cancellation NEVER
// emits a CANCELLED event. COMPLETED 409 / NOT_FOUND / STATE_MISMATCH / failure
// paths emit nothing.
// ------------------------------------------------------------

describe("DiningSessionService SERVICE_REQUEST_CANCELLED emission (D2.5G4)", () => {
  beforeEach(() => {
    // mockReset clears call history AND any mockImplementation/mockRejectedValue
    // leaked from earlier emission-failure tests, keeping the default mock
    // resolve-undefined semantics for every G4 test.
    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
  });

  it("A. PENDING -> CANCELLED emits exactly one SERVICE_REQUEST_CANCELLED event", async () => {
    const { port } = makeCnrPort({ lockedRequest: cnrRequest({ status: "PENDING" }) });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_CANCELLED");
  });

  it("B. ACKNOWLEDGED -> CANCELLED emits exactly one SERVICE_REQUEST_CANCELLED event", async () => {
    const { port } = makeCnrPort({ lockedRequest: cnrRequest({ status: "ACKNOWLEDGED" }) });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("SERVICE_REQUEST_CANCELLED");
  });

  it("C. fact derived from the authoritative transition.value", async () => {
    const committed = cnrRequest({
      id: "req-authoritative",
      session_id: "session-authoritative",
      request_type: "CALL_STAFF",
    });
    const { port } = makeCnrPort({
      transition: { kind: "UPDATED", value: committed },
    });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput({ request_id: "req-input" }));
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_CANCELLED",
      request_id: "req-authoritative",
      session_id: "session-authoritative",
      restaurant_id: "rest-1",
      request_type: "CALL_STAFF",
      request_status: "PENDING",
    });
  });

  it("D. aggregate id is the cancelled request id", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts[0]).toMatchObject({ request_id: "req-e4" });
    expect(outcome.value.request.id).toBe("req-e4");
  });

  it("E. correlation_id is preserved into the emitter call", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput({ correlation_id: "corr-g4" }));
    const [, correlationId] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(correlationId).toBe("corr-g4");
  });

  it("F. payload is minimal and derives from the authoritative DTO (no note/PII/table token)", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput({ request_id: "ignored-by-fact" }));
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    // The fixture DTO is WATER/CANCELLED/req-e4 regardless of input. No
    // cancelled_at/cancelled_by, no note.
    expect(facts[0]).toEqual({
      kind: "SERVICE_REQUEST_CANCELLED",
      request_id: "req-e4",
      session_id: "session-e4",
      restaurant_id: "rest-1",
      request_type: "WATER",
      request_status: "CANCELLED",
    });
  });

  it("G. emission happens only AFTER the transaction callback resolves", async () => {
    const order: string[] = [];
    const repos = {
      diningSessions: {
        lockById: vi.fn().mockResolvedValue(cnrSession({})),
      },
      serviceRequests: {
        getById: vi.fn().mockResolvedValue(cnrRequest()),
        lockById: vi.fn().mockResolvedValue(cnrRequest()),
        cancel: vi.fn().mockResolvedValue({
          kind: "UPDATED",
          value: cnrRequest({ status: "CANCELLED" }),
        }),
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        order.push("tx-callback-start");
        const result = await fn(repos);
        order.push("tx-callback-end");
        return result;
      },
    };
    vi.mocked(emitDineInEventFactsBestEffort).mockImplementation(async () => {
      order.push("emit");
    });
    const service = new DiningSessionService(port);
    await service.cancelServiceRequest(cnrInput());
    expect(order.indexOf("tx-callback-end")).toBeLessThan(order.indexOf("emit"));
    expect(order.filter((e) => e === "emit")).toHaveLength(1);
  });

  it("H. emission failure does NOT fail the committed cancellation result", async () => {
    const { port } = makeCnrPort({});
    vi.mocked(emitDineInEventFactsBestEffort).mockRejectedValue(
      new Error("bus down"),
    );
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(outcome.value.request.status).toBe("CANCELLED");
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
  });

  it("I. CANCELLED idempotent retry emits NOTHING", async () => {
    const { port } = makeCnrPort({ lockedRequest: cnrRequest({ status: "CANCELLED" }) });
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(outcome.eventFacts).toEqual([]);
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("J. COMPLETED 409 rejection emits nothing", async () => {
    const { port } = makeCnrPort({ lockedRequest: cnrRequest({ status: "COMPLETED" }) });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("K. BRING_BILL PENDING 409 rejection emits nothing", async () => {
    const { port } = makeCnrPort({
      lockedRequest: cnrRequest({ request_type: "BRING_BILL", status: "PENDING" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("L. BRING_BILL ACKNOWLEDGED 409 rejection emits nothing", async () => {
    const { port } = makeCnrPort({
      lockedRequest: cnrRequest({ request_type: "BRING_BILL", status: "ACKNOWLEDGED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("M. BRING_BILL CANCELLED 409 rejection emits nothing", async () => {
    const { port } = makeCnrPort({
      lockedRequest: cnrRequest({ request_type: "BRING_BILL", status: "CANCELLED" }),
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "BRING_BILL_MANAGED_BY_BILL_FLOW",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("N. CAS NOT_FOUND rejection emits nothing", async () => {
    const { port } = makeCnrPort({ transition: { kind: "NOT_FOUND" } });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "SERVICE_REQUEST_NOT_FOUND",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("O. CAS STATE_MISMATCH rejection emits nothing", async () => {
    const { port } = makeCnrPort({
      transition: { kind: "STATE_MISMATCH", current: "COMPLETED" },
    });
    const service = new DiningSessionService(port);
    await expect(service.cancelServiceRequest(cnrInput())).rejects.toMatchObject({
      code: "INVALID_SERVICE_REQUEST_TRANSITION",
    });
    expect(vi.mocked(emitDineInEventFactsBestEffort)).not.toHaveBeenCalled();
  });

  it("P. CREATED/ACKNOWLEDGED/COMPLETED event behavior is unchanged", async () => {
    const { port: csrPort } = makeCsrPort(csrSession({ status: "OPEN" }));
    const createService = new DiningSessionService(csrPort);
    await createService.createServiceRequest(csrInput());
    const [createFacts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(createFacts[0]!.kind).toBe("SERVICE_REQUEST_CREATED");
    expect(createFacts).toHaveLength(1);

    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
    const { port: asrPort } = makeAsrPort({});
    const ackService = new DiningSessionService(asrPort);
    await ackService.acknowledgeServiceRequest(asrInput());
    const [ackFacts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(ackFacts[0]!.kind).toBe("SERVICE_REQUEST_ACKNOWLEDGED");
    expect(ackFacts).toHaveLength(1);

    vi.mocked(emitDineInEventFactsBestEffort).mockReset();
    const { port: cmrPort } = makeCmrPort({});
    const completeService = new DiningSessionService(cmrPort);
    await completeService.completeServiceRequest(cmrInput());
    const [completeFacts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(completeFacts[0]!.kind).toBe("SERVICE_REQUEST_COMPLETED");
    expect(completeFacts).toHaveLength(1);
  });

  it("Q. exactly one event per successful generic cancellation", async () => {
    const { port } = makeCnrPort({});
    const service = new DiningSessionService(port);
    const outcome = (await service.cancelServiceRequest(cnrInput())) as MutationOutcome<
      CancelServiceRequestResult,
      DineInEventFact
    >;
    expect(vi.mocked(emitDineInEventFactsBestEffort)).toHaveBeenCalledTimes(1);
    const [facts] = vi.mocked(emitDineInEventFactsBestEffort).mock.calls[0]!;
    expect(facts).toHaveLength(1);
    expect(outcome.eventFacts).toHaveLength(1);
    expect(outcome.eventFacts.every((f) => f.kind === "SERVICE_REQUEST_CANCELLED")).toBe(
      true,
    );
  });
});

describe("DiningSessionService.resolveTable (UI1-A-R3)", () => {
  // A port whose runInTransaction THROWS: resolveTable must never open a
  // transaction (read-only public resolve). Reaching a resolved value means no
  // transaction was opened and no session mutation path was touched.
  function makeReadOnlyPort() {
    return {
      runInTransaction: async <T>(
        _fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => {
        throw new Error("resolveTable must NOT open a transaction");
      },
    };
  }

  const eligible: TableResolveDTO = {
    restaurant: { id: "rest-1", name: "Test Restaurant" },
    table: { id: "table-1", label: "Table 12" },
    can_start_session: true,
  };

  it("A. eligible token -> exact trusted DTO, no token/internal fields, repo called once", async () => {
    const resolver: TableResolveRepository = {
      resolveByToken: vi.fn().mockResolvedValue(eligible),
    };
    const service = new DiningSessionService(makeReadOnlyPort(), vi.fn(), resolver);
    const result = await service.resolveTable("tok-eligible");
    expect(result).toEqual(eligible);
    expect(Object.keys(result).sort()).toEqual(["can_start_session", "restaurant", "table"]);
    expect(Object.keys(result.restaurant).sort()).toEqual(["id", "name"]);
    expect(Object.keys(result.table).sort()).toEqual(["id", "label"]);
    expect(JSON.stringify(result)).not.toContain("tok-eligible");
    expect(vi.mocked(resolver.resolveByToken)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolver.resolveByToken)).toHaveBeenCalledWith("tok-eligible");
  });

  it("B. unknown token -> TABLE_NOT_FOUND 404, no token in error, repo called once", async () => {
    const resolver: TableResolveRepository = {
      resolveByToken: vi.fn().mockResolvedValue(null),
    };
    const service = new DiningSessionService(makeReadOnlyPort(), vi.fn(), resolver);
    try {
      await service.resolveTable("tok-unknown");
      expect.unreachable("resolveTable should have thrown");
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("TABLE_NOT_FOUND");
      expect(e.status).toBe(404);
      expect(e.message).not.toContain("tok-unknown");
    }
    expect(vi.mocked(resolver.resolveByToken)).toHaveBeenCalledTimes(1);
  });

  it("C. disabled/ineligible null path -> same TABLE_NOT_FOUND 404 (collapsed)", async () => {
    const resolver: TableResolveRepository = {
      resolveByToken: vi.fn().mockResolvedValue(null),
    };
    const service = new DiningSessionService(makeReadOnlyPort(), vi.fn(), resolver);
    await expect(service.resolveTable("tok-disabled")).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
      status: 404,
    });
    await expect(service.resolveTable("tok-inactive-restaurant")).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
      status: 404,
    });
    expect(vi.mocked(resolver.resolveByToken)).toHaveBeenCalledTimes(2);
  });

  it("D. empty/whitespace token -> TABLE_NOT_FOUND 404 without calling repository", async () => {
    const resolver: TableResolveRepository = { resolveByToken: vi.fn() };
    const service = new DiningSessionService(makeReadOnlyPort(), vi.fn(), resolver);
    for (const bad of ["", "   "]) {
      await expect(service.resolveTable(bad)).rejects.toMatchObject({
        code: "TABLE_NOT_FOUND",
        status: 404,
      });
    }
    expect(vi.mocked(resolver.resolveByToken)).not.toHaveBeenCalled();
  });

  it("E. no transaction / no session mutation / no event emission", async () => {
    const resolver: TableResolveRepository = {
      resolveByToken: vi.fn().mockResolvedValue(eligible),
    };
    const emitter = vi.fn();
    const service = new DiningSessionService(makeReadOnlyPort(), emitter, resolver);
    const result = await service.resolveTable("tok-eligible");
    expect(result).toEqual(eligible);
    // makeReadOnlyPort.runInTransaction throws; resolving here proves no tx opened.
    expect(emitter).not.toHaveBeenCalled();
  });

  it("F. resolver not configured -> INTERNAL_ERROR 500 (wiring guard)", async () => {
    const service = new DiningSessionService(makeReadOnlyPort());
    await expect(service.resolveTable("tok-x")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });
});
