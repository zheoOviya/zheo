import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToasterHost } from "@/components/ToasterHost";
import { ClientProviders } from "@/components/ClientProviders";
import { Container } from "@snakzap/ui";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SnakZap - Order Ahead, Skip the Wait",
  description: "Pickup-first food ordering. Browse restaurants, filter dietary, order in 3 taps.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${jetbrains.variable} min-h-dvh bg-surface-light dark:bg-surface-dark font-sans text-neutral-800 dark:text-neutral-200 antialiased`}
      >
        <ClientProviders>
          <Container>{children}</Container>
        </ClientProviders>
        <ToasterHost />
      </body>
    </html>
  );
}
