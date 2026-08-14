// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import UsersPage from "./page";

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

const USERS = {
  items: [
    {
      id: "u00000000-0000-4000-8000-000000000001",
      phone: "+919876000111",
      role: "CONSUMER",
      is_suspended: false,
      created_at: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "u00000000-0000-4000-8000-000000000002",
      phone: "+919876000222",
      role: "ADMIN",
      is_suspended: true,
      created_at: "2026-08-02T10:00:00.000Z",
    },
  ],
  total: 2,
};

describe("Admin users page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchUsers.mockResolvedValue(USERS);
    mocks.getSessionRoles.mockResolvedValue(["ADMIN"]);
  });

  it("renders users from the API", async () => {
    render(<UsersPage />);
    expect(await screen.findByText("+919876000111")).toBeTruthy();
    expect(screen.getByText("+919876000222")).toBeTruthy();
  });

  it("links each phone to its Customer 360 page", async () => {
    render(<UsersPage />);
    const link = (await screen.findByText("+919876000111")).closest("a");
    expect(link?.getAttribute("href")).toBe("/users/u00000000-0000-4000-8000-000000000001");
  });
});
