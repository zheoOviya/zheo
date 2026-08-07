import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Checkout - SnakZap",
};

export default function CheckoutRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
