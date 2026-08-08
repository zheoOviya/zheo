import type { Metadata } from "next";
import "./globals.css";
import { ToasterHost } from "@/components/ToasterHost";
import { ClientProviders } from "@/components/ClientProviders";

export const metadata: Metadata = {
  title: "SnakZap - Order Ahead, Skip the Wait",
  description: "Pickup-first food ordering. Browse restaurants, filter dietary, order in 3 taps.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-light dark:bg-surface-dark font-sans text-neutral-800 dark:text-neutral-200 antialiased">
        <ClientProviders>
          {children}
        </ClientProviders>
        <ToasterHost />
      </body>
    </html>
  );
}
