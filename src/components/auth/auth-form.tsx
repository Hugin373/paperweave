"use client";

import { BookOpen } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/search";
}

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isLogin = mode === "login";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = isLogin
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] });
    if (result.error) {
      setLoading(false);
      const { status, code, message } = result.error;
      setError(
        status === 429
          ? "Too many attempts. Please wait a minute and try again."
          : isLogin && (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD")
            ? "That email and password don't match an account."
            : message || (isLogin ? "Sign-in failed. Please try again." : "The account could not be created."),
      );
      return;
    }
    router.push(safeNext(params.get("next")));
    router.refresh();
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center gap-2 lg:hidden">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent">
          <BookOpen className="size-4" aria-hidden />
        </span>
        <span className="text-lg font-semibold">Paperweave</span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">{isLogin ? "Welcome back" : "Create your workspace"}</h2>
      <p className="mt-1 text-sm text-muted">
        {isLogin ? "Sign in to continue your research." : "Free, private, and accessible from any device."}
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4" noValidate={false}>
        {!isLogin && (
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Ada Lovelace"
            />
          </Field>
        )}
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label="Password" htmlFor="password" hint={isLogin ? undefined : "At least 8 characters."}>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? "current-password" : "new-password"}
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={loading}>
          {isLogin ? "Sign in" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        {isLogin ? "New here? " : "Already have an account? "}
        <Link
          href={`${isLogin ? "/register" : "/login"}${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}
          className="font-medium text-accent-text hover:underline"
        >
          {isLogin ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}
