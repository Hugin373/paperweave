"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { relativeTime } from "@/lib/format";
import { useMe } from "@/lib/hooks";

function describeAgent(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  const browser = /Firefox/.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return [browser, os].filter(Boolean).join(" on ");
}

function ProfileForm({ initialName, email }: { initialName: string; email: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const saveName = useMutation({
    mutationFn: () => api("/api/me", { method: "PATCH", body: { name } }),
    onSuccess: () => {
      toast.success("Name updated");
      router.refresh();
      return qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <h3 className="font-medium">Profile</h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveName.mutate();
        }}
      >
        <Field label="Name" htmlFor="acc-name" className="min-w-56 flex-1">
          <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Button type="submit" loading={saveName.isPending} disabled={!name.trim() || name === initialName}>
          Save
        </Button>
      </form>
      <p className="text-sm text-muted">Email: {email}</p>
    </section>
  );
}

export function AccountSettings() {
  const { data: me } = useMe();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");

  const session = authClient.useSession();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const res = await authClient.listSessions();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    // In single-user mode there is no sign-in, so no list of signed-in devices.
    enabled: !!me && !me.singleUser,
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      const res = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
      if (res.error) throw new Error(res.error.message || "The password could not be changed.");
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed. Other devices were signed out.");
      return sessions.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const revokeOthers = useMutation({
    mutationFn: () => authClient.revokeOtherSessions(),
    onSuccess: () => {
      toast.success("Signed out of all other devices");
      return sessions.refetch();
    },
  });

  const deleteAccount = useMutation({
    mutationFn: async () => {
      const res = await authClient.deleteUser({ password: deletePassword });
      if (res.error) throw new Error(res.error.message || "The account could not be deleted.");
    },
    onSuccess: () => {
      router.push("/register");
      router.refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (me?.singleUser) {
    return (
      <div className="max-w-2xl space-y-6">
        <ProfileForm key={me.user.name} initialName={me.user.name} email={me.user.email} />
        <section className="space-y-2 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-medium">Sign-in</h3>
          <p className="text-sm text-muted">
            Single-user mode is on: this computer and your Tailscale devices open Paperweave without signing in. Your
            password is kept; to change it, manage devices or delete the account, remove SINGLE_USER_EMAIL from{" "}
            <code>.env</code>, restart Paperweave and sign in.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {me && <ProfileForm key={me.user.name} initialName={me.user.name} email={me.user.email} />}

      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-medium">Password</h3>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <Field label="Current password" htmlFor="acc-cur">
            <Input
              id="acc-cur"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="New password" htmlFor="acc-new" hint="At least 8 characters.">
            <Input
              id="acc-new"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </Field>
          <div>
            <Button type="submit" loading={changePassword.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Signed-in devices</h3>
          <Button size="sm" variant="ghost" onClick={() => revokeOthers.mutate()} loading={revokeOthers.isPending}>
            <LogOut />
            Sign out other devices
          </Button>
        </div>
        <p className="text-sm text-muted">
          Your workspace is stored in the cloud — sign in from any computer to continue where you left off.
        </p>
        <ul className="divide-y divide-border">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <Laptop className="size-4 text-muted" aria-hidden />
              <span className="flex-1">{describeAgent(s.userAgent)}</span>
              {s.token === session.data?.session.token && <Badge tone="success">This device</Badge>}
              <span className="text-[12.5px] text-subtle">
                active {relativeTime(new Date(s.updatedAt).toISOString())}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-xl border border-danger/30 bg-surface p-5">
        <h3 className="font-medium text-danger">Delete account</h3>
        <p className="text-sm text-muted">
          Permanently deletes your account and your workspace (library, notes, concepts, highlights, PDFs). Export your
          data first if you want to keep it.
        </p>
        <Button variant="danger-ghost" onClick={() => setDeleting(true)}>
          Delete my account…
        </Button>
        <Dialog open={deleting} onOpenChange={setDeleting}>
          <DialogContent
            title="Delete your account?"
            description="This cannot be undone. Enter your password to confirm."
          >
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                deleteAccount.mutate();
              }}
            >
              <Field label="Password" htmlFor="del-pass">
                <Input
                  id="del-pass"
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeleting(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" loading={deleteAccount.isPending}>
                  Delete permanently
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}
