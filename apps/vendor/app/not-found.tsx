import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-primary-900 px-4">
      <div className="text-center max-w-sm">
        <p className="text-6xl font-bold text-primary-600/40">404</p>
        <h1 className="mt-4 text-xl font-bold text-neutral-200">Page not found</h1>
        <p className="mt-2 text-sm text-neutral-400">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block min-h-[44px] rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
        >
          Back to Dashboard
        </Link>
      </div>
    </main>
  );
}
