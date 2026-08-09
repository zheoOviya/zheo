"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LazyMotion, domMax } from "framer-motion";
import { Container } from "@snakzap/ui";
import VendorNav from "./VendorNav";

export function VendorLayoutClient({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isDashboard = pathname === "/";

  return (
    <LazyMotion features={domMax} strict>
      {isDashboard ? (
        <>{children}</>
      ) : (
        <>
          <VendorNav />
          <Container>{children}</Container>
        </>
      )}
    </LazyMotion>
  );
}
