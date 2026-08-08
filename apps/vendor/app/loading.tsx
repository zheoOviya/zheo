import { Skeleton } from "@snakzap/ui";

export default function Loading() {
  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center justify-between shrink-0 border-b border-primary-500/10 px-5 py-3">
        <div>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-2 h-3 w-24" />
        </div>
        <Skeleton className="h-4 w-12" />
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-3 p-4 min-w-[960px]">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex w-full min-w-0 flex-col rounded-xl bg-neutral-900/50 border border-neutral-800/50"
            >
              <div className="flex items-center justify-between p-3 border-b border-neutral-800/50">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-6 rounded-full" />
              </div>
              <div className="flex-1 p-2 space-y-2">
                {[0, 1].map((j) => (
                  <div
                    key={j}
                    className="rounded-xl border-l-4 border-neutral-800/50 bg-neutral-900/30 p-4"
                  >
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="mt-3 h-3 w-full" />
                    <Skeleton className="mt-2 h-3 w-2/3" />
                    <Skeleton className="mt-4 h-9 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
