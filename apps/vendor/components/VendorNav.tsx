"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/chain", label: "Chain Overview" },
  { href: "/catering", label: "Catering" },
  { href: "/settlements", label: "Settlements" },
  { href: "/menu", label: "Menu" },
  { href: "/menu/bulk", label: "Bulk Menu" },
  { href: "/promotions", label: "Promotions" },
  { href: "/gst", label: "GST" },
  { href: "/insights", label: "Insights" },
  { href: "/pos", label: "POS" },
];

export default function VendorNav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-primary-500/10 bg-primary-900/40">
      <div className="mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto px-4 py-3">
        <Link href="/" className="mr-2 shrink-0 text-sm font-bold text-primary-400">
          SnakZap
        </Link>
        <div className="flex gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary-500/20 text-primary-300"
                    : "text-primary-600/60 hover:text-primary-400"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
