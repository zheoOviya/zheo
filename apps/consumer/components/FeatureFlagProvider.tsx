"use client";

import { createContext, useContext, useCallback } from "react";

export interface FeatureFlags {
  ab_menu_images: boolean;
  ab_pickup_slots: boolean;
  ab_animated_tracker: boolean;
}

const defaultFlags: FeatureFlags = {
  ab_menu_images: true,
  ab_pickup_slots: true,
  ab_animated_tracker: false,
};

const FeatureFlagContext = createContext<{
  flags: FeatureFlags;
  isEnabled: (flag: keyof FeatureFlags) => boolean;
}>({
  flags: defaultFlags,
  isEnabled: (flag) => defaultFlags[flag],
});

export function useFeatureFlags() {
  return useContext(FeatureFlagContext);
}

export function FeatureFlagProvider({
  children,
  overrides,
}: {
  children: React.ReactNode;
  overrides?: Partial<FeatureFlags>;
}) {
  const flags = { ...defaultFlags, ...overrides };

  const isEnabled = useCallback(
    (flag: keyof FeatureFlags) => flags[flag],
    [flags],
  );

  return (
    <FeatureFlagContext.Provider value={{ flags, isEnabled }}>
      {children}
    </FeatureFlagContext.Provider>
  );
}
