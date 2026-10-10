/**
 * Connection-string options understood by libpq (psql, pg_dump) but not by postgres.js, which would
 * send them to the server as settings and fail. Neon's connection strings include `channel_binding`.
 */
const LIBPQ_ONLY = ["channel_binding", "gssencmode", "target_session_attrs"];

/** The connection string with libpq-only options removed. */
export function postgresUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of LIBPQ_ONLY) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}
