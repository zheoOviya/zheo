"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { accessToken, isAuthenticated, refreshAccessToken } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) return;

    refreshAccessToken()
      .then((ok) => {
        if (!ok) {
          router.replace("/login");
        }
      })
      .catch(() => {
        router.replace("/login");
      });
  }, [isAuthenticated, refreshAccessToken, router]);

  if (!accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-light">
        <div className="space-y-4 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <p className="text-sm text-neutral-400">Verifying session...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
