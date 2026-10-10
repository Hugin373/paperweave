import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/server/db/client";
import { accounts, sessions, users, verifications } from "@/server/db/schema";
import { env } from "@/server/env";
import { createPersonalWorkspace, deleteOwnedWorkspaces } from "@/server/workspaces";

function createAuth() {
  const e = env();
  return betterAuth({
    appName: "Paperweave",
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    // In development the dev server may fall back to another port (e.g. 3301 when 3300 is taken),
    // so any localhost origin is trusted there. Production only trusts APP_URL.
    trustedOrigins: async (request) => {
      const origins = [e.APP_URL, ...e.TRUSTED_ORIGINS];
      const origin = request?.headers.get("origin");
      if (e.NODE_ENV !== "production" && origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        origins.push(origin);
      }
      return origins;
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      disableSignUp: !e.ALLOW_REGISTRATION,
    },
    user: {
      deleteUser: {
        enabled: true,
        // Personal workspaces (and everything in them) are deleted with their owner.
        beforeDelete: async (user) => {
          await deleteOwnedWorkspaces(user.id);
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // A signed copy of the session in a cookie saves a database lookup on most requests (noticeable
      // with a cloud database). A sign-out elsewhere takes effect here within this many seconds.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: {
      enabled: e.NODE_ENV === "production" && e.AUTH_RATE_LIMIT,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: e.APP_URL.startsWith("https://"),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await createPersonalWorkspace(user.id, user.name);
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazily constructed so that building the app does not require runtime secrets. */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
