import { logger } from "./lib/logger";

// ============================================
// Delayed seed module for the shutdown.subprocess seed_import regression.
//
// Simulates a dynamic seed import (mirrors index.ts's
// `await import("./seed/phase4Demo")`). The fixture pauses while this module
// is "in flight", then awaits it; once resolved it must re-check
// shutdown.started() before calling seedPhase4DemoData(). Marker sequence:
//   seed_module_loaded  -> the import DID resolve after shutdown began
//   seed_ran            -> must never appear (side effect suppressed)
// ============================================

logger.info({ message: "FIXTURE:seed_module_loaded" });

export function seedPhase4DemoData(): void {
  logger.info({ message: "FIXTURE:seed_ran" });
}
