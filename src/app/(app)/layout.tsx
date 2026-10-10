import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/app-shell";
import { env } from "@/server/env";
import { getSessionUser } from "@/server/http";

// Always rendered per request (session-dependent; no build-time secrets needed).
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell user={{ name: user.name, email: user.email }} singleUser={!!env().SINGLE_USER_EMAIL}>
      {children}
    </AppShell>
  );
}
