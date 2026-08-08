"use client";

export default function ErrorPage({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-light px-4">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary-500/10">
          <svg className="h-8 w-8 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-neutral-700">Something went wrong</h1>
        <p className="mt-2 text-sm text-neutral-500">
          We encountered an unexpected error. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
        >
          Try Again
        </button>
      </div>
    </main>
  );
}
