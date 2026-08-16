import { beforeEach, describe, expect, it } from "vitest";
import { MemoryUserRoleRepository } from "./userRoleRepository";

// ============================================
// Scoped roles repository unit tests
// ============================================

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const REST_ID = "a0000000-0000-4000-8000-000000000001";
const CHAIN_ID = "c0000000-0000-4000-8000-000000000001";

describe("MemoryUserRoleRepository", () => {
  let repo: MemoryUserRoleRepository;

  beforeEach(() => {
    repo = new MemoryUserRoleRepository();
  });

  it("assigns a scoped role and reports membership", async () => {
    await repo.assign({ user_id: USER_A, scope_type: "restaurant", scope_id: REST_ID, role: "VENDOR_OWNER" });
    expect(await repo.isMember(USER_A, "restaurant", REST_ID)).toBe(true);
    expect(await repo.isMember(USER_B, "restaurant", REST_ID)).toBe(false);
  });

  it("idempotently updates the role for an existing membership", async () => {
    await repo.assign({ user_id: USER_A, scope_type: "restaurant", scope_id: REST_ID, role: "VENDOR_STAFF" });
    await repo.assign({ user_id: USER_A, scope_type: "restaurant", scope_id: REST_ID, role: "VENDOR_OWNER" });

    const roles = await repo.findByUser(USER_A);
    expect(roles).toHaveLength(1);
    expect(roles[0]!.role).toBe("VENDOR_OWNER");
  });

  it("treats scope_id null (platform) distinctly from a real id", async () => {
    await repo.assign({ user_id: USER_A, scope_type: "platform", scope_id: null, role: "ADMIN" });
    await repo.assign({ user_id: USER_A, scope_type: "restaurant", scope_id: REST_ID, role: "VENDOR_OWNER" });

    expect(await repo.isMember(USER_A, "platform", null)).toBe(true);
    expect(await repo.isMember(USER_A, "restaurant", REST_ID)).toBe(true);

    const platform = await repo.findByScope("platform", null);
    expect(platform).toHaveLength(1);
    expect(platform[0]!.scope_id).toBeNull();
  });

  it("supports chain-scope membership for multi-outlet access", async () => {
    await repo.assign({ user_id: USER_A, scope_type: "chain", scope_id: CHAIN_ID, role: "VENDOR_OWNER" });
    expect(await repo.isMember(USER_A, "chain", CHAIN_ID)).toBe(true);
    expect(await repo.isMember(USER_A, "restaurant", REST_ID)).toBe(false);
  });
});
