import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "SnakZap Merchant",
  description: "Run your restaurant: live orders, menu, money and more.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
