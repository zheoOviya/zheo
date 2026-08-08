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
    <main className="mx-auto max-w-2xl py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-700">Group Order</h1>
          <p className="mt-1 text-sm text-neutral-500">
            One shared order, many contributors.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
        >
          Back Home
        </Link>
      </header>

      {!token ? (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-neutral-500">
            Missing invite link. Ask whoever started the group order for the
            shareable link.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Browse Restaurants
          </Link>
        </div>
      ) : (
        <GroupCartView token={token} />
      )}
    </main>
  );
}
