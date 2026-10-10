"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Globe, Link2, Lock, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, qs } from "@/lib/api";
import type { ShareDto } from "@/lib/types";

type ResourceType = "collection" | "note" | "concept";

const NOUN: Record<ResourceType, string> = { collection: "collection", note: "note", concept: "concept" };

export function ShareDialog({
  open,
  onOpenChange,
  resourceType,
  resourceId,
  title,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  resourceType: ResourceType;
  resourceId: string;
  title: string;
}) {
  const qc = useQueryClient();
  const key = ["shares", resourceType, resourceId];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api<ShareDto[]>(`/api/shares${qs({ resourceType, resourceId })}`),
    enabled: open,
  });
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [copied, setCopied] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const invite = useMutation({
    mutationFn: () =>
      api<ShareDto>("/api/shares", { body: { resourceType, resourceId, email: email.trim(), permission } }),
    onSuccess: (s) => {
      setEmail("");
      toast.success(`Shared with ${s.grantee?.name ?? "them"}`);
      return refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const createLink = useMutation({
    mutationFn: () => api<ShareDto>("/api/shares", { body: { resourceType, resourceId, link: true } }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: ({ id, permission: p }: { id: string; permission: "view" | "edit" }) =>
      api(`/api/shares/${id}`, { method: "PATCH", body: { permission: p } }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/shares/${id}`, { method: "DELETE" }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const people = (data ?? []).filter((s) => s.grantee);
  const link = (data ?? []).find((s) => s.linkUrl);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        title={`Share “${title || "Untitled"}”`}
        description={`Your ${NOUN[resourceType]} is private until you share it. Viewers can read it; editors can also make changes. Access is checked on the server for every request.`}
      >
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate();
          }}
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email of a Paperweave user"
            aria-label="Email address to share with"
            className="flex-1"
          />
          <Select
            value={permission}
            onChange={(e) => setPermission(e.target.value as "view" | "edit")}
            aria-label="Permission"
            className="sm:w-32"
          >
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </Select>
          <Button type="submit" variant="primary" loading={invite.isPending} disabled={!email.trim()}>
            <UserPlus />
            Invite
          </Button>
        </form>

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">People with access</h3>
          {isLoading && <Spinner label="Loading…" />}
          {error && <ErrorState error={error} onRetry={() => refetch()} />}
          {!isLoading && !error && !people.length && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Lock className="size-4" aria-hidden />
              Only you can access this {NOUN[resourceType]}.
            </p>
          )}
          <ul className="divide-y divide-border">
            {people.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
                  {s.grantee!.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.grantee!.name}</span>
                  <span className="block truncate text-[12px] text-muted">{s.grantee!.email}</span>
                </span>
                <Select
                  value={s.permission}
                  onChange={(e) => update.mutate({ id: s.id, permission: e.target.value as "view" | "edit" })}
                  aria-label={`Permission for ${s.grantee!.name}`}
                  className="h-8 w-28"
                >
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </Select>
                <Button
                  size="icon"
                  variant="danger-ghost"
                  onClick={() => revoke.mutate(s.id)}
                  aria-label={`Remove ${s.grantee!.name}`}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 rounded-xl border border-border bg-surface-2/50 p-3.5">
          <div className="flex items-start gap-3">
            <Globe className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Public link</p>
              <p className="text-[13px] text-muted">Anyone with the link can view (read-only), without signing in.</p>
              {link?.linkUrl && (
                <div className="mt-2 flex gap-2">
                  <Input
                    readOnly
                    value={link.linkUrl}
                    aria-label="Public link"
                    className="h-8 flex-1 font-mono text-[12px]"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button size="sm" onClick={() => copy(link.linkUrl!)}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              )}
            </div>
            {link ? (
              <Button
                size="sm"
                variant="danger-ghost"
                loading={revoke.isPending}
                onClick={() => revoke.mutate(link.id)}
              >
                Disable
              </Button>
            ) : (
              <Button size="sm" loading={createLink.isPending} onClick={() => createLink.mutate()}>
                <Link2 />
                Create link
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
