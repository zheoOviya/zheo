// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RolesPage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchRoles: vi.fn(),
  fetchUsers: vi.fn(),
  suspendUser: vi.fn(),
  reactivateUser: vi.fn(),
  updateUserRole: vi.fn(),
  deleteRole: vi.fn(),
  createRole: vi.fn(),
  getSessionRoles: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);

const BUILTIN = [
  { name: "CONSUMER", label: "Consumer", description: "End users", permissions: ["Order"], is_builtin: true, member_count: 3 },
  { name: "ADMIN", label: "Admin", description: "Console operators", permissions: ["Manage users"], is_builtin: true, member_count: 5 },
  { name: "SUPER_ADMIN", label: "Super Admin", description: "Full control", permissions: ["Everything"], is_builtin: true, member_count: 2 },
];

function userList(total: number, role = "ADMIN") {
  return {
    items: Array.from({ length: Math.min(total, 20) }, (_, i) => ({
      id: `u-${role}-${i}`,
      phone: `+9198700000${String(i).padStart(2, "0")}`,
      role,
      is_suspended: i % 3 === 0,
      created_at: "2026-08-13T00:00:00.000Z",
    })),
    total,
  };
}

describe("Roles page (role management)", () => {
  beforeEach(() => {
    mocks.createRole.mockClear();
    mocks.deleteRole.mockClear();
    mocks.updateUserRole.mockClear();
    mocks.suspendUser.mockClear();
    mocks.reactivateUser.mockClear();
    mocks.fetchRoles.mockResolvedValue(BUILTIN);
    mocks.fetchUsers.mockImplementation((page: number, search?: string, role?: string) =>
      Promise.resolve(userList(role === "SUPER_ADMIN" ? 2 : 5, role)),
    );
    mocks.getSessionRoles.mockResolvedValue(["ADMIN"]);
    mocks.deleteRole.mockResolvedValue({ removed: "X" });
    mocks.createRole.mockResolvedValue({ ...BUILTIN[1], name: "SUPPORT_LEAD", label: "Support Lead" });
  });

  it("renders role cards with member counts from the catalog", async () => {
    render(<RolesPage />);
    expect(await screen.findByText("Super Admin")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/members/).length).toBeGreaterThan(0));
    expect(mocks.fetchRoles).toHaveBeenCalled();
  });

  it("lists members for the selected role (default Admin)", async () => {
    render(<RolesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Admin members/ })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getAllByText("+919870000000").length).toBeGreaterThan(0),
    );
  });

  it("filters members when another role is selected", async () => {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByText("Super Admin")).toBeTruthy());
    fireEvent.click(screen.getByText("Super Admin"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Super Admin members/ })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(mocks.fetchUsers).toHaveBeenCalledWith(1, undefined, "SUPER_ADMIN"),
    );
  });

  it("shows a role dropdown for super admins only", async () => {
    mocks.getSessionRoles.mockResolvedValue(["SUPER_ADMIN"]);
    render(<RolesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Admin members/ })).toBeTruthy(),
    );
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });

  it("super admins can open the add-role form and create a role", async () => {
    mocks.getSessionRoles.mockResolvedValue(["SUPER_ADMIN"]);
    render(<RolesPage />);
    await waitFor(() => screen.getByRole("button", { name: /Add Role/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add Role/ }));

    const dialog = screen.getByRole("dialog", { name: /Add role/ });
    expect(dialog).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("SUPPORT_LEAD"), {
      target: { value: "SUPPORT_LEAD" },
    });
    fireEvent.change(screen.getByPlaceholderText("Support Lead"), {
      target: { value: "Support Lead" },
    });
    fireEvent.change(screen.getByPlaceholderText("What does this role do?"), {
      target: { value: "Leads the support pod" },
    });
    fireEvent.change(screen.getByPlaceholderText("Triage tickets, Escalate"), {
      target: { value: "Triage, Escalate" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Role/ }));

    await waitFor(() =>
      expect(mocks.createRole).toHaveBeenCalledWith({
        name: "SUPPORT_LEAD",
        label: "Support Lead",
        description: "Leads the support pod",
        permissions: ["Triage", "Escalate"],
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("validates the role name format", async () => {
    mocks.getSessionRoles.mockResolvedValue(["SUPER_ADMIN"]);
    render(<RolesPage />);
    await waitFor(() => screen.getByRole("button", { name: /Add Role/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add Role/ }));

    fireEvent.change(screen.getByPlaceholderText("SUPPORT_LEAD"), {
      target: { value: "support lead" },
    });
    fireEvent.change(screen.getByPlaceholderText("Support Lead"), {
      target: { value: "Support Lead" },
    });
    fireEvent.change(screen.getByPlaceholderText("What does this role do?"), {
      target: { value: "Leads the support pod" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Role/ }));

    expect(await screen.findByText(/Name must be SCREAMING_SNAKE_CASE/)).toBeTruthy();
    expect(mocks.createRole).not.toHaveBeenCalled();
  });

  it("super admins can delete a custom role", async () => {
    mocks.getSessionRoles.mockResolvedValue(["SUPER_ADMIN"]);
    mocks.fetchRoles.mockResolvedValue([
      ...BUILTIN,
      { name: "SUPPORT_LEAD", label: "Support Lead", description: "Support pod lead", permissions: ["Triage"], is_builtin: false, member_count: 0 },
    ]);
    render(<RolesPage />);
    await waitFor(() => screen.getByRole("button", { name: /Delete role/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete role/ }));
    await waitFor(() => expect(mocks.deleteRole).toHaveBeenCalledWith("SUPPORT_LEAD"));
  });
});
