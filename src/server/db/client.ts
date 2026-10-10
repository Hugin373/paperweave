import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/server/env";
import * as schema from "./schema";
import { postgresUrl } from "./url";

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Either the root database handle or a transaction. */
export type Executor = Database | Transaction;

const globalForDb = globalThis as unknown as { __pwSql?: postgres.Sql; __pwDb?: Database };

/**
 * Drizzle runs queries through `sql.unsafe()`, which postgres.js does not prepare by default: every query
 * with parameters then costs an extra round trip to the server (to learn the parameter types). Locally that
 * is invisible; against a cloud database ~70 ms away it doubled every request. This makes `unsafe()`
 * prepare (and cache) its statements, also inside transactions and savepoints.
 */
export function preparedQueries<T extends postgres.Sql | postgres.TransactionSql>(sql: T): T {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "unsafe") {
        return (query: string, params?: unknown[], options?: postgres.UnsafeQueryOptions) =>
          (value as postgres.Sql["unsafe"]).call(target, query, params as never, { prepare: true, ...options });
      }
      if (prop === "begin" || prop === "savepoint") {
        return (...args: unknown[]) => {
          const fn = args.at(-1) as (tx: postgres.TransactionSql) => unknown;
          return (value as (...a: unknown[]) => unknown).call(
            target,
            ...args.slice(0, -1),
            (tx: postgres.TransactionSql) => fn(preparedQueries(tx)),
          );
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function create(): Database {
  const client = postgres(postgresUrl(env().DATABASE_URL), { max: 10, onnotice: () => {} });
  globalForDb.__pwSql = client;
  return drizzle(preparedQueries(client), { schema, casing: undefined });
}

/** Lazily-created singleton; survives hot reloads in development. */
export function getDb(): Database {
  if (!globalForDb.__pwDb) globalForDb.__pwDb = create();
  return globalForDb.__pwDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
});

export async function closeDb() {
  await globalForDb.__pwSql?.end({ timeout: 5 });
  globalForDb.__pwSql = undefined;
  globalForDb.__pwDb = undefined;
}
