import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { DineInResolver } from "./DineInResolver";
import { openDineInSession, resolveDineInTable } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useDineInStore } from "@/store/dineIn";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, resolveDineInTable: vi.fn(), openDineInSession: vi.fn() };
});

const RESOLVED = {
  restaurant: { id: "r1", name: "SnakShack" },
  table: { id: "t1", label: "Table 12" },
  can_start_session: true,
};

const SESSION_CREATED = {
  id: "s1",
  restaurant_id: "r1",
  table_id: "t1",
  owner_user_id: "u1",
  status: "OPEN",
  bill_requested_at: null,
  payment_pending_at: null,
  closed_at: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const SESSION_RESUMED = {
  ...SESSION_CREATED,
  id: "s2",
  status: "ACTIVE",
};

function authState(overrides: Record<string, unknown> = {}) {
  useAuthStore.setState({
    accessToken: null,
    user: null,
    isAuthenticated: false,
    refreshAccessToken: vi.fn().mockRejectedValue(new Error("no session")),
    ...overrides,
  });
}

describe("Dine-in QR resolution screen (UI1-B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockClear();
    authState();
    useDineInStore.getState().clearContext();
  });

  it("resolves a valid token to restaurant + table confirmation", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    render(<DineInResolver token="secret-table-token" />);

    expect(await screen.findByText("SnakShack")).toBeTruthy();
    expect(screen.getByText("Table 12")).toBeTruthy();
    expect(screen.getByText("Ready to order")).toBeTruthy();
    expect(resolveDineInTable).toHaveBeenCalledTimes(1);
    expect(resolveDineInTable).toHaveBeenCalledWith("secret-table-token");
  });

  it("shows a loading skeleton while resolving and visibly mutates the DOM", async () => {
    let release!: (v: typeof RESOLVED) => void;
    vi.mocked(resolveDineInTable).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<DineInResolver token="tok" />);

    expect((await screen.findAllByRole("status")).length).toBeGreaterThan(0);
    expect(screen.queryByText("SnakShack")).toBeNull();

    await act(async () => {
      release(RESOLVED as never);
    });

    expect(await screen.findByText("SnakShack")).toBeTruthy();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("shows Invalid table QR without any API call when the token is missing", async () => {
    render(<DineInResolver token={null} />);

    expect(await screen.findByText("Invalid table QR")).toBeTruthy();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });

  it("maps a 404 / TABLE_NOT_FOUND to a safe not-found error (no raw dump)", async () => {
    const err = new Error("Table not found") as Error & {
      status?: number;
      code?: string;
    };
    err.code = "TABLE_NOT_FOUND";
    err.status = 404;
    vi.mocked(resolveDineInTable).mockRejectedValue(err);

    render(<DineInResolver token="tok" />);

    expect(await screen.findByText("Table not found or unavailable")).toBeTruthy();
    expect(screen.queryByText("Table not found")).toBeNull();
    expect(screen.queryByText("tok")).toBeNull();
  });

  it("maps a 500 / network failure to a retry UI and retries successfully", async () => {
    const netErr = new Error("fetch failed") as Error & {
      status?: number;
      code?: string;
    };
    netErr.status = 500;
    vi.mocked(resolveDineInTable)
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(RESOLVED as never);

    render(<DineInResolver token="tok" />);

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(await screen.findByText("SnakShack")).toBeTruthy();
    expect(resolveDineInTable).toHaveBeenCalledTimes(2);
  });

  it("never renders the opaque token in the DOM", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    const { container } = render(<DineInResolver token="super-secret-token-xyz" />);

    await screen.findByText("SnakShack");

    expect(container.textContent).not.toContain("super-secret-token-xyz");
  });

  it("only issues the public resolve call - no session mutation", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    render(<DineInResolver token="tok" />);

    await screen.findByText("SnakShack");

    expect(resolveDineInTable).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveDineInTable).mock.calls).toEqual([["tok"]]);
    expect(openDineInSession).not.toHaveBeenCalled();
  });
});

describe("Dine-in session entry (UI1-B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockClear();
    authState();
    useDineInStore.getState().clearContext();
  });

  it("A. unauthenticated Continue bounces to login and never POSTs /sessions", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    render(<DineInResolver token="tok" />);

    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        `/login?from=${encodeURIComponent("/dine-in?table=tok")}`,
      ),
    );
    expect(openDineInSession).not.toHaveBeenCalled();
  });

  it("B. authenticated Continue opens the session exactly once and reaches Session ready", async () => {
    authState({ accessToken: "t", isAuthenticated: true, user: { id: "u1", phone: "9999", role: "CONSUMER" } });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);

    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(await screen.findByText("Session ready")).toBeTruthy();
    expect(openDineInSession).toHaveBeenCalledTimes(1);
    expect(openDineInSession).toHaveBeenCalledWith("tok", "t");
    expect(screen.queryByText("tok")).toBeNull();
  });

  it("C. both CREATED and RESUMED outcomes reach Session ready", async () => {
    authState({ accessToken: "t", isAuthenticated: true });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);

    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);
    const first = render(<DineInResolver token="tok" />);
    fireEvent.click(await first.findByRole("button", { name: /Continue/ }));
    expect(await first.findByText("Session ready")).toBeTruthy();

    first.unmount();

    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_RESUMED } as never);
    const second = render(<DineInResolver token="tok" />);
    fireEvent.click(await second.findByRole("button", { name: /Continue/ }));
    expect(await second.findByText("Session ready")).toBeTruthy();
  });

  it("D. TABLE_OCCUPIED 409 shows a safe occupied message (no raw dump)", async () => {
    authState({ accessToken: "t", isAuthenticated: true });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    const err = new Error("Table occupied") as Error & {
      status?: number;
      code?: string;
    };
    err.status = 409;
    err.code = "TABLE_OCCUPIED";
    vi.mocked(openDineInSession).mockRejectedValue(err);

    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(await screen.findByText("This table is already in use")).toBeTruthy();
    expect(screen.queryByText("Table occupied")).toBeNull();
  });

  it("E. network/500 open error shows a retry UI and retries successfully", async () => {
    authState({ accessToken: "t", isAuthenticated: true });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    const netErr = new Error("fetch failed") as Error & {
      status?: number;
      code?: string;
    };
    netErr.status = 500;
    vi.mocked(openDineInSession)
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ session: SESSION_CREATED } as never);

    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(await screen.findByText("Session ready")).toBeTruthy();
    expect(openDineInSession).toHaveBeenCalledTimes(2);
  });

  it("F. a double click cannot create two POST /sessions", async () => {
    authState({ accessToken: "t", isAuthenticated: true });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    let release!: (v: { session: typeof SESSION_CREATED }) => void;
    vi.mocked(openDineInSession).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<DineInResolver token="tok" />);
    const button = await screen.findByRole("button", { name: /Continue/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(openDineInSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ session: SESSION_CREATED });
    });
    expect(await screen.findByText("Session ready")).toBeTruthy();
  });

  it("G. token is never rendered in the DOM after opening", async () => {
    authState({ accessToken: "t", isAuthenticated: true });
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);

    const { container } = render(<DineInResolver token="super-secret" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    await screen.findByText("Session ready");

    expect(container.textContent).not.toContain("super-secret");
  });
});

describe("Dine-in context store integration (UI1-B4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockClear();
    authState({ accessToken: "t", isAuthenticated: true });
    useDineInStore.getState().clearContext();
  });

  async function openAndWait() {
    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    await screen.findByText("Session ready");
  }

  it("A. successful CREATED populates the minimal context", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);

    await openAndWait();

    expect(useDineInStore.getState().context).toEqual({
      sessionId: SESSION_CREATED.id,
      restaurant: { id: RESOLVED.restaurant.id, name: RESOLVED.restaurant.name },
      table: { id: RESOLVED.table.id, label: RESOLVED.table.label },
      sessionStatus: "OPEN",
    });
  });

  it("B. successful RESUMED populates the same minimal context", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_RESUMED } as never);

    await openAndWait();

    expect(useDineInStore.getState().context).toEqual({
      sessionId: SESSION_RESUMED.id,
      restaurant: { id: RESOLVED.restaurant.id, name: RESOLVED.restaurant.name },
      table: { id: RESOLVED.table.id, label: RESOLVED.table.label },
      sessionStatus: "ACTIVE",
    });
  });

  it("C. restaurant-id mismatch fails closed: no store, safe error", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({
      session: { ...SESSION_CREATED, restaurant_id: "other-restaurant" },
    } as never);

    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(useDineInStore.getState().context).toBeNull();
    expect(screen.queryByText(SESSION_CREATED.id)).toBeNull();
    expect(screen.queryByText("other-restaurant")).toBeNull();
  });

  it("D. table-id mismatch fails closed: no store, safe error", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({
      session: { ...SESSION_CREATED, table_id: "other-table" },
    } as never);

    render(<DineInResolver token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(useDineInStore.getState().context).toBeNull();
    expect(screen.queryByText("other-table")).toBeNull();
  });

  it("E. the opaque token never enters the store", async () => {
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);

    const { container } = render(<DineInResolver token="super-secret-tok" />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    await screen.findByText("Session ready");

    expect(JSON.stringify(useDineInStore.getState().context)).not.toContain(
      "super-secret-tok",
    );
    expect(container.textContent).not.toContain("super-secret-tok");
  });

  it("F. clearContext resets the store", () => {
    useDineInStore.getState().setContext({
      sessionId: "s1",
      restaurant: { id: "r1", name: "SnakShack" },
      table: { id: "t1", label: "Table 12" },
      sessionStatus: "OPEN",
    });
    useDineInStore.getState().clearContext();
    expect(useDineInStore.getState().context).toBeNull();
  });
});

describe("Dine-in entry -> menu navigation (UI1-B5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockClear();
    authState({ accessToken: "t", isAuthenticated: true });
    useDineInStore.getState().clearContext();
    vi.mocked(resolveDineInTable).mockResolvedValue(RESOLVED as never);
    vi.mocked(openDineInSession).mockResolvedValue({ session: SESSION_CREATED } as never);
  });

  async function openAndReachReady(token = "tok") {
    render(<DineInResolver token={token} />);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    await screen.findByText("Session ready");
  }

  it("5. successful entry makes the explicit View Menu action available", async () => {
    await openAndReachReady();
    expect(screen.getByRole("button", { name: /View Menu/ })).toBeTruthy();
  });

  it("6. View Menu navigates to /dine-in/menu on explicit click only", async () => {
    await openAndReachReady();
    // No auto-navigation on session creation.
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /View Menu/ }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/dine-in/menu");
  });

  it("7. the menu navigation target carries no token; store and DOM stay token-free", async () => {
    await openAndReachReady("super-secret-tok");

    fireEvent.click(screen.getByRole("button", { name: /View Menu/ }));

    const url = pushMock.mock.calls[0]![0] as string;
    expect(url).toBe("/dine-in/menu");
    expect(url).not.toContain("super-secret-tok");
    expect(url).not.toContain("table=");
    expect(JSON.stringify(useDineInStore.getState().context)).not.toContain(
      "super-secret-tok",
    );
    expect(screen.queryByText("super-secret-tok")).toBeNull();
  });
});
