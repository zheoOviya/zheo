import type { Metadata } from "next";
import "./globals.css";
import { VendorLayoutClient } from "@/components/VendorLayoutClient";

export const metadata: Metadata = {
  title: "SnakZap Kitchen - Dashboard",
  description: "Real-time order management for restaurant staff.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 font-sans antialiased">
        <VendorLayoutClient>{children}</VendorLayoutClient>
      </body>
    </html>
  );
}
