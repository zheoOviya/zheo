import type { Metadata } from "next";
import "./globals.css";
import VendorNav from "@/components/VendorNav";

export const metadata: Metadata = {
  title: "SnakZap Vendor - Kitchen Dashboard",
  description: "Real-time order management, settlements and menu for restaurant staff.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <VendorNav />
        {children}
      </body>
    </html>
  );
}
