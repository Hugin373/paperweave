import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-muted">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">
        The page you’re looking for doesn’t exist or you don’t have access to it.
      </p>
      <Link href="/search" className="mt-2 text-sm font-medium text-accent-text hover:underline">
        Go to search
      </Link>
    </div>
  );
}
