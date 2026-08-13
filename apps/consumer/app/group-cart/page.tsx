import Link from "next/link";
import { GroupCartView } from "@/components/GroupCartView";

// Shared group-order landing page. The token in the URL query is the
// share-key: anyone with the link can view the live cart and, once signed
// in, add their own items to the same DRAFT order (O02).

export default async function GroupCartPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto max-w-2xl py-6 pb-28">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="section-eyebrow">Together</p>
          <h1 className="section-title">Group Order</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            One shared order, many contributors.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white px-3.5 text-xs font-semibold text-neutral-600 shadow-elevation-1 ring-1 ring-neutral-900/5 transition-colors hover:bg-surface-light dark:bg-neutral-900 dark:text-neutral-300 dark:ring-white/10"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back Home
        </Link>
      </header>

      {!token ? (
        <div className="surface-card p-8 text-center">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Missing invite link. Ask whoever started the group order for the shareable link.
          </p>
          <Link href="/" className="btn-primary mt-4">
            Browse Restaurants
          </Link>
        </div>
      ) : (
        <GroupCartView token={token} />
      )}
    </main>
  );
}
