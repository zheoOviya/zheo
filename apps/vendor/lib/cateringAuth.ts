"use client";

// Backward-compatible re-export. The full vendor API client now lives in
// lib/api.ts (demo OTP login + typed endpoints). Keep this module as a thin
// alias so existing imports (catering/chain pages) keep working.
export { authedFetch } from "./api";
