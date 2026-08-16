import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vendor_applications } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// Vendor onboarding applications (marketplace)
// A restaurant owner applies to onboard; admins approve (creating a
// restaurant + upgrading the owner to VENDOR_OWNER) or reject.
// ============================================

export type VendorApplicationStatus = "PENDING" | "APPROVED" | "REJECTED";
export type VendorApplicationType = "SINGLE" | "CHAIN";

export interface VendorApplicationDTO {
  id: string;
  applicant_id: string;
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  contact_email?: string | null;
  address?: string | null;
  city?: string | null;
  lat: number | null;
  lng: number | null;
  commission_rate: number;
  status: VendorApplicationStatus;
  type: VendorApplicationType;
  outlet_count: number;
  rejection_reason?: string | null;
  reviewer_id?: string | null;
  reviewed_at?: string | null;
  created_at: string;
}

export interface CreateVendorApplicationInput {
  applicant_id: string;
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  contact_email?: string | null;
  address?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  commission_rate?: number;
  type?: VendorApplicationType;
  outlet_count?: number;
}

export interface VendorApplicationTrendPoint {
  date: string;
  submitted: number;
  approved: number;
  rejected: number;
}

export interface VendorApplicationMetrics {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  trend: VendorApplicationTrendPoint[];
}

export interface VendorApplicationRepository {
  create(input: CreateVendorApplicationInput): Promise<VendorApplicationDTO>;
  getById(id: string): Promise<VendorApplicationDTO | null>;
  listAll(status?: VendorApplicationStatus): Promise<VendorApplicationDTO[]>;
  listByApplicant(applicantId: string): Promise<VendorApplicationDTO[]>;
  getMetrics(days?: number): Promise<VendorApplicationMetrics>;
  updateStatus(
    id: string,
    status: VendorApplicationStatus,
    reviewerId: string,
    rejectionReason?: string | null,
  ): Promise<VendorApplicationDTO | null>;
  _seed(app: VendorApplicationDTO): void;
  _reset(): void;
}

function computeMetrics(apps: VendorApplicationDTO[], days: number): VendorApplicationMetrics {
  const total = apps.length;
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  for (const a of apps) {
    if (a.status === "PENDING") pending += 1;
    else if (a.status === "APPROVED") approved += 1;
    else if (a.status === "REJECTED") rejected += 1;
  }

  const buckets = new Map<string, VendorApplicationTrendPoint>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, submitted: 0, approved: 0, rejected: 0 });
  }
  for (const a of apps) {
    const submittedDay = a.created_at.slice(0, 10);
    const sb = buckets.get(submittedDay);
    if (sb) sb.submitted += 1;
    if (a.status === "APPROVED" || a.status === "REJECTED") {
      const reviewedDay = (a.reviewed_at ?? a.created_at).slice(0, 10);
      const rb = buckets.get(reviewedDay);
      if (rb) {
        if (a.status === "APPROVED") rb.approved += 1;
        else rb.rejected += 1;
      }
    }
  }
  const trend = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));

  return { total, pending, approved, rejected, trend };
}

export class MemoryVendorApplicationRepository implements VendorApplicationRepository {
  private readonly applications = new Map<string, VendorApplicationDTO>();

  async create(input: CreateVendorApplicationInput): Promise<VendorApplicationDTO> {
    const app: VendorApplicationDTO = {
      id: randomUUID(),
      applicant_id: input.applicant_id,
      name: input.name,
      gst_number: input.gst_number,
      fssai_license: input.fssai_license,
      phone: input.phone,
      contact_email: input.contact_email ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      commission_rate: input.commission_rate ?? 0.08,
      status: "PENDING",
      type: input.type ?? "SINGLE",
      outlet_count: Math.max(1, input.outlet_count ?? 1),
      rejection_reason: null,
      reviewer_id: null,
      reviewed_at: null,
      created_at: new Date().toISOString(),
    };
    this.applications.set(app.id, app);
    return app;
  }

  async getById(id: string): Promise<VendorApplicationDTO | null> {
    return this.applications.get(id) ?? null;
  }

  async listAll(status?: VendorApplicationStatus): Promise<VendorApplicationDTO[]> {
    let all = Array.from(this.applications.values());
    if (status) {
      all = all.filter((a) => a.status === status);
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return all;
  }

  async listByApplicant(applicantId: string): Promise<VendorApplicationDTO[]> {
    return Array.from(this.applications.values())
      .filter((a) => a.applicant_id === applicantId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getMetrics(days = 14): Promise<VendorApplicationMetrics> {
    return computeMetrics(Array.from(this.applications.values()), days);
  }

  async updateStatus(
    id: string,
    status: VendorApplicationStatus,
    reviewerId: string,
    rejectionReason?: string | null,
  ): Promise<VendorApplicationDTO | null> {
    const app = this.applications.get(id);
    if (!app) return null;
    const updated: VendorApplicationDTO = {
      ...app,
      status,
      reviewer_id: reviewerId,
      reviewed_at: new Date().toISOString(),
      rejection_reason: status === "REJECTED" ? rejectionReason ?? null : null,
    };
    this.applications.set(id, updated);
    return updated;
  }

  _seed(app: VendorApplicationDTO): void {
    this.applications.set(app.id, app);
  }

  _reset(): void {
    this.applications.clear();
  }
}

export class DrizzleVendorApplicationRepository implements VendorApplicationRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRow(row: Record<string, unknown>): VendorApplicationDTO {
    return {
      id: row.id as string,
      applicant_id: row.applicant_id as string,
      name: row.name as string,
      gst_number: row.gst_number as string,
      fssai_license: row.fssai_license as string,
      phone: row.phone as string,
      contact_email: (row.contact_email as string | null) ?? null,
      address: (row.address as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      lat: (row.lat as number | null) ?? null,
      lng: (row.lng as number | null) ?? null,
      commission_rate: Number(row.commission_rate ?? 0.08),
      status: row.status as VendorApplicationStatus,
      type: (row.type as VendorApplicationType) ?? "SINGLE",
      outlet_count: Number(row.outlet_count ?? 1),
      rejection_reason: (row.rejection_reason as string | null) ?? null,
      reviewer_id: (row.reviewer_id as string | null) ?? null,
      reviewed_at: row.reviewed_at
        ? (row.reviewed_at as Date).toISOString()
        : null,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  async create(input: CreateVendorApplicationInput): Promise<VendorApplicationDTO> {
    const id = randomUUID();
    await this.db.insert(vendor_applications).values({
      id,
      applicant_id: input.applicant_id,
      name: input.name,
      gst_number: input.gst_number,
      fssai_license: input.fssai_license,
      phone: input.phone,
      contact_email: input.contact_email ?? undefined,
      address: input.address ?? undefined,
      city: input.city ?? undefined,
      lat: input.lat ?? undefined,
      lng: input.lng ?? undefined,
      commission_rate: String(input.commission_rate ?? 0.08),
      status: "PENDING",
      type: input.type ?? "SINGLE",
      outlet_count: Math.max(1, input.outlet_count ?? 1),
    });
    const app = await this.getById(id);
    return app!;
  }

  async getById(id: string): Promise<VendorApplicationDTO | null> {
    const rows = (await this.db
      .select()
      .from(vendor_applications)
      .where(eq(vendor_applications.id, id))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async listAll(status?: VendorApplicationStatus): Promise<VendorApplicationDTO[]> {
    const rows = (status
      ? await this.db
          .select()
          .from(vendor_applications)
          .where(eq(vendor_applications.status, status))
      : await this.db.select().from(vendor_applications)) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  async listByApplicant(applicantId: string): Promise<VendorApplicationDTO[]> {
    const rows = (await this.db
      .select()
      .from(vendor_applications)
      .where(eq(vendor_applications.applicant_id, applicantId))) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  async getMetrics(days = 14): Promise<VendorApplicationMetrics> {
    const apps = await this.listAll();
    return computeMetrics(apps, days);
  }

  async updateStatus(
    id: string,
    status: VendorApplicationStatus,
    reviewerId: string,
    rejectionReason?: string | null,
  ): Promise<VendorApplicationDTO | null> {
    await this.db
      .update(vendor_applications)
      .set({
        status,
        reviewer_id: reviewerId,
        reviewed_at: new Date(),
        rejection_reason: status === "REJECTED" ? rejectionReason ?? null : null,
      })
      .where(eq(vendor_applications.id, id));
    return this.getById(id);
  }

  _seed(_app: VendorApplicationDTO): void {}

  _reset(): void {}
}
