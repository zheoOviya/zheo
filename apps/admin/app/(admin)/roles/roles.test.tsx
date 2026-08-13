// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RolesPage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  suspendUser: vi.fn(),
  reactivateUser: vi.fn(),
  updateUserRole: vi.fn(),
  getSessionRoles: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);

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
    mocks.fetchUsers.mockImplementation((page: number, search?: string, role?: string) =>
      Promise.resolve(userList(role === "SUPER_ADMIN" ? 2 : 5, role)),
    );
    mocks.getSessionRoles.mockResolvedValue(["ADMIN"]);
  });

  it("renders role cards with member counts", async () => {
    render(<RolesPage />);
    expect(await screen.findByText("Super Admin")).toBeTruthy();
    expect(await screen.findByText("Consumer")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/5 members/).length).toBeGreaterThan(0));
    expect(mocks.fetchUsers).toHaveBeenCalled();
  });

  it("lists members for the selected role (default ADMIN)", async () => {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: /Admin members/ })).toBeTruthy());
    await waitFor(() =>
      expect(screen.getAllByText("+919870000000").length).toBeGreaterThan(0),
    );
  });

  it("filters members when another role is selected", async () => {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByText("Super Admin")).toBeTruthy());
    fireEvent.click(screen.getByText("Super Admin"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Super Admin members/ })).toBeTruthy());
    await waitFor(() =>
      expect(mocks.fetchUsers).toHaveBeenCalledWith(1, undefined, "SUPER_ADMIN"),
    );
  });

  it("shows a role dropdown for super admins only", async () => {
    mocks.getSessionRoles.mockResolvedValue(["SUPER_ADMIN"]);
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: /Admin members/ })).toBeTruthy());
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });
});
