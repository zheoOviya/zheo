import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { sharedVendorApplicationRepo } from "../repositories/shared";

// ============================================
// Vendor onboarding applications (public side)
// Any authenticated user (typically a restaurant owner who just signed up
// as a CONSUMER) can apply to onboard as a vendor. Admin review happens on
// the /admin/vendor-applications endpoints.
// ============================================

export const vendorApplicationRouter: Router = Router();

const ApplySchema = z.object({
  name: z.string().min(2).max(120),
  gst_number: z.string().min(5).max(30),
  fssai_license: z.string().min(5).max(60),
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
  contact_email: z.string().email().optional().nullable(),
  address: z.string().min(5).max(300).optional().nullable(),
  city: z.string().min(2).max(80).optional().nullable(),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  type: z.enum(["SINGLE", "CHAIN"]).default("SINGLE"),
  outlet_count: z.number().int().min(1).max(50).default(1),
});

vendorApplicationRouter.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = ApplySchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid application payload", 400, body.error.flatten());
    }
    const applicantId = res.locals.userId as string;
    const app = await sharedVendorApplicationRepo.create({
      applicant_id: applicantId,
      name: body.data.name,
      gst_number: body.data.gst_number,
      fssai_license: body.data.fssai_license,
      phone: body.data.phone,
      contact_email: body.data.contact_email ?? null,
      address: body.data.address ?? null,
      city: body.data.city ?? null,
      lat: body.data.lat ?? null,
      lng: body.data.lng ?? null,
      type: body.data.type,
      outlet_count: body.data.type === "CHAIN" ? body.data.outlet_count : 1,
    });
    ok(res, app);
  }),
);

vendorApplicationRouter.get(
  "/mine",
  authenticate,
  asyncHandler(async (req, res) => {
    const applicantId = res.locals.userId as string;
    const apps = await sharedVendorApplicationRepo.listByApplicant(applicantId);
    ok(res, apps);
  }),
);
