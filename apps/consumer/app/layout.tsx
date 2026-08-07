import type { Metadata } from "next";
import "./globals.css";
import { ToasterHost } from "@/components/ToasterHost";

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
      <body className="min-h-screen bg-surface-light font-sans text-neutral-800 antialiased">
        {children}
        <ToasterHost />
      </body>
    </html>
  );
}
