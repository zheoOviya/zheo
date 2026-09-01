import { DineInMenuShell } from "./DineInMenuShell";

// ============================================
// /dine-in/menu route shell (frozen UI1-B5).
//
// This page deliberately reads NO searchParams — the menu URL must never carry
// the table token. All state comes from the memory-only context store via the
// client shell, which either renders trusted cached display data or fails back
// to explicit re-scan guidance (cold reload / direct navigation).
//
// No menu catalog, no API, no cart, no order mutation — menu UI arrives in a
// later checkpoint.
// ============================================

export default function DineInMenuPage() {
  return <DineInMenuShell />;
}
