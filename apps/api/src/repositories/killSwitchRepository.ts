import { eq } from "drizzle-orm";
import { killSwitches } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

export interface KillSwitchDTO {
  id: string;
  switch_name: string;
  is_triggered: boolean;
  threshold_value: number;
  current_value: number;
  updated_at: string;
}

export interface KillSwitchRepository {
  getAll(): Promise<KillSwitchDTO[]>;
  getByName(name: string): Promise<KillSwitchDTO | null>;
  upsert(name: string, data: { is_triggered: boolean; threshold_value: number; current_value: number }): Promise<KillSwitchDTO>;
  _reset(): void;
}

export class MemoryKillSwitchRepository implements KillSwitchRepository {
  private switches = new Map<string, KillSwitchDTO>();

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const defaults = [
      { switch_name: "vendor_churn_protection", threshold_value: 10, current_value: 2.3 },
      { switch_name: "cac_gtv_protection", threshold_value: 1.0, current_value: 0.68 },
      { switch_name: "webhook_fallback", threshold_value: 1.0, current_value: 0.05 },
    ];
    for (const d of defaults) {
      const id = `ks-${d.switch_name}`;
      if (!this.switches.has(d.switch_name)) {
        this.switches.set(d.switch_name, {
          id,
          switch_name: d.switch_name,
          is_triggered: false,
          threshold_value: d.threshold_value,
          current_value: d.current_value,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  async getAll(): Promise<KillSwitchDTO[]> {
    return Array.from(this.switches.values());
  }

  async getByName(name: string): Promise<KillSwitchDTO | null> {
    return this.switches.get(name) ?? null;
  }

  async upsert(
    name: string,
    data: { is_triggered: boolean; threshold_value: number; current_value: number },
  ): Promise<KillSwitchDTO> {
    const existing = this.switches.get(name);
    const dto: KillSwitchDTO = {
      id: existing?.id ?? `ks-${name}`,
      switch_name: name,
      is_triggered: data.is_triggered,
      threshold_value: data.threshold_value,
      current_value: data.current_value,
      updated_at: new Date().toISOString(),
    };
    this.switches.set(name, dto);
    return dto;
  }

  _reset(): void {
    this.switches.clear();
    this.seedDefaults();
  }
}

export class DrizzleKillSwitchRepository implements KillSwitchRepository {
  constructor(private readonly db: DrizzleDb) {
    this.seedDefaults().catch(() => {});
  }

  private async seedDefaults(): Promise<void> {
    const defaults = [
      { switch_name: "vendor_churn_protection", threshold_value: 10, current_value: 2.3 },
      { switch_name: "cac_gtv_protection", threshold_value: 1.0, current_value: 0.68 },
      { switch_name: "webhook_fallback", threshold_value: 1.0, current_value: 0.05 },
    ];
    for (const d of defaults) {
      const existing = await this.getByName(d.switch_name);
      if (!existing) {
        await this.db.insert(killSwitches).values({
          switch_name: d.switch_name,
          is_triggered: false,
          threshold_value: d.threshold_value,
          current_value: d.current_value,
        });
      }
    }
  }

  async getAll(): Promise<KillSwitchDTO[]> {
    const rows = (await this.db
      .select()
      .from(killSwitches)
      .where(undefined!)) as Record<string, unknown>[];
    return rows.map(this.mapRow);
  }

  async getByName(name: string): Promise<KillSwitchDTO | null> {
    const rows = (await this.db
      .select()
      .from(killSwitches)
      .where(eq(killSwitches.switch_name, name))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async upsert(
    name: string,
    data: { is_triggered: boolean; threshold_value: number; current_value: number },
  ): Promise<KillSwitchDTO> {
    const existing = await this.getByName(name);
    if (existing) {
      await this.db
        .update(killSwitches)
        .set({
          is_triggered: data.is_triggered,
          threshold_value: data.threshold_value,
          current_value: data.current_value,
          updated_at: new Date(),
        })
        .where(eq(killSwitches.id, existing.id));
      return (await this.getByName(name))!;
    }
    await this.db.insert(killSwitches).values({
      switch_name: name,
      is_triggered: data.is_triggered,
      threshold_value: data.threshold_value,
      current_value: data.current_value,
    });
    return (await this.getByName(name))!;
  }

  private mapRow(row: Record<string, unknown>): KillSwitchDTO {
    return {
      id: row.id as string,
      switch_name: row.switch_name as string,
      is_triggered: (row.is_triggered as boolean) ?? false,
      threshold_value: Number(row.threshold_value),
      current_value: Number(row.current_value),
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  _reset(): void {
    // DB-backed: truncate and re-seed
  }
}
