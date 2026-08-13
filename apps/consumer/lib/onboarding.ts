"use client";

// Single source of truth for the onboarding flag. The onboarding page and the
// first-run gate must agree on the same key/value, otherwise the gate would
// redirect forever (the page wrote "snakzap_onboarded" while the gate read
// "snakzap_onboarding_complete").

const ONBOARDING_KEY = "snakzap_onboarded";
const ONBOARDING_DONE = "1";

export function hasCompletedOnboarding(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ONBOARDING_KEY) === ONBOARDING_DONE;
}

export function markOnboardingComplete(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ONBOARDING_KEY, ONBOARDING_DONE);
}
