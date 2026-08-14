import { randomUUID } from "node:crypto";

// ============================================
// Role catalog bounded context (admin console)
// Built-in roles are static metadata; custom roles created by a
// SUPER_ADMIN are stored here. Assigning a role to a user just writes
// the role string on the identity, so custom roles work end-to-end.
// ============================================

export interface CustomRole {
  id: string;
  name: string;
  label: string;
  description: string;
  permissions: string[];
  created_at: string;
}

export interface RoleRepository {
  create(input: {
    name: string;
    label: string;
    description: string;
    permissions: string[];
  }): Promise<CustomRole>;
  getByName(name: string): Promise<CustomRole | null>;
  list(): Promise<CustomRole[]>;
  remove(name: string): Promise<boolean>;
  _reset(): void;
}

export class MemoryRoleRepository implements RoleRepository {
  private readonly rolesByName = new Map<string, CustomRole>();

  async create(input: {
    name: string;
    label: string;
    description: string;
    permissions: string[];
  }): Promise<CustomRole> {
    const role: CustomRole = {
      id: randomUUID(),
      name: input.name,
      label: input.label,
      description: input.description,
      permissions: input.permissions,
      created_at: new Date().toISOString(),
    };
    this.rolesByName.set(role.name, role);
    return role;
  }

  async getByName(name: string): Promise<CustomRole | null> {
    return this.rolesByName.get(name) ?? null;
  }

  async list(): Promise<CustomRole[]> {
    return Array.from(this.rolesByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async remove(name: string): Promise<boolean> {
    return this.rolesByName.delete(name);
  }

  _reset(): void {
    this.rolesByName.clear();
  }
}
