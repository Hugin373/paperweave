"use client";

import { Download, Sparkles, Upload, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AccountSettings } from "@/components/settings/account-settings";
import { AiSettings } from "@/components/settings/ai-settings";
import { ExportPanel, ImportPanel } from "@/components/settings/import-export";
import { PageLoading } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["account", "ai", "import", "export"] as const;

function SettingsTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = TABS.includes(params.get("tab") as (typeof TABS)[number]) ? params.get("tab")! : "account";
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Tabs value={tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`)}>
        <TabsList>
          <TabsTrigger value="account">
            <User />
            Account
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles />
            AI
          </TabsTrigger>
          <TabsTrigger value="import">
            <Upload />
            Import
          </TabsTrigger>
          <TabsTrigger value="export">
            <Download />
            Export
          </TabsTrigger>
        </TabsList>
        <TabsContent value="account" className="pt-6">
          <AccountSettings />
        </TabsContent>
        <TabsContent value="ai" className="pt-6">
          <AiSettings />
        </TabsContent>
        <TabsContent value="import" className="pt-6">
          <ImportPanel />
        </TabsContent>
        <TabsContent value="export" className="pt-6">
          <ExportPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SettingsTabs />
    </Suspense>
  );
}
