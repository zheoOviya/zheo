import type { Metadata } from "next";
import AuthGuard from "../components/AuthGuard";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnakZap Ops Console",
  description: "Real-time operations dashboard for SnakZap pickup platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="light">
      <body className="min-h-screen bg-surface-light font-sans text-neutral-800 antialiased">
        <AuthGuard>{children}</AuthGuard>
      </body>
    </html>
  );
}
