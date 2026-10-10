"use client";

import {
  BellRing,
  BookOpen,
  ChevronDown,
  FolderOpen,
  Library,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  MessagesSquare,
  Moon,
  Network,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Share2,
  Sun,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { collectionColor } from "@/lib/collection-colors";
import { useCollections } from "@/lib/hooks";
import { usePersistentState } from "@/lib/use-persistent-state";
import { CollectionDialog } from "@/components/library/collection-dialog";
import { useAlerts } from "@/components/alerts/alerts-view";
import { CommandPalette } from "./command-palette";

const NAV = [
  { href: "/search", label: "Search", icon: Search, match: ["/search", "/papers"] },
  { href: "/research", label: "Assistant", icon: MessagesSquare, match: ["/research"] },
  { href: "/library", label: "Library", icon: Library, match: ["/library", "/collections"] },
  { href: "/graph", label: "Graph", icon: Network, match: ["/graph"] },
  { href: "/notes", label: "Notes", icon: NotebookPen, match: ["/notes", "/concepts"] },
  { href: "/alerts", label: "New papers", icon: BellRing, match: ["/alerts"] },
  { href: "/screening", label: "Screening", icon: ListChecks, match: ["/screening"] },
];

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function useTheme() {
  const dark = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("pw-theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  };
  return { dark, toggle };
}

function Sidebar({
  user,
  singleUser,
  onNavigate,
}: {
  user: { name: string; email: string };
  singleUser?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const unseen = useAlerts().data?.unseen ?? 0;
  const router = useRouter();
  const { data: collections } = useCollections();
  const { dark, toggle } = useTheme();
  const [newCollection, setNewCollection] = useState(false);

  const signOut = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 px-3 py-4">
      <Link href="/search" onClick={onNavigate} className="mb-4 flex items-center gap-2 px-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent">
          <BookOpen className="size-4" aria-hidden />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Paperweave</span>
      </Link>

      {NAV.map(({ href, label, icon: Icon, match }) => {
        const badge = href === "/alerts" && unseen ? unseen : 0;
        const active = match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
              active ? "bg-surface-3/70 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {badge > 0 && (
              <span
                className="ml-auto rounded-full bg-accent px-1.5 text-[11px] leading-[1.6] font-semibold text-on-accent"
                aria-label={`${badge} new`}
              >
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </Link>
        );
      })}

      <div className="mt-6 flex items-center justify-between px-2.5">
        <span className="text-xs font-medium tracking-wide text-subtle uppercase">Collections</span>
        <button
          type="button"
          onClick={() => setNewCollection(true)}
          className="rounded p-0.5 text-subtle hover:bg-surface-2 hover:text-text"
          aria-label="New collection"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {collections?.length ? (
          collections.map((c) => {
            const href = `/library?collection=${c.id}`;
            return (
              <Link
                key={c.id}
                href={href}
                onClick={onNavigate}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
              >
                <FolderOpen className="size-3.5 shrink-0" style={{ color: collectionColor(c) }} aria-hidden />
                <span className="truncate">{c.name}</span>
                <span className="ml-auto text-[11px] text-subtle">{c.paperCount}</span>
              </Link>
            );
          })
        ) : (
          <p className="px-2.5 py-1 text-[12.5px] text-subtle">
            Group papers into collections like “Thesis” or “To read”.
          </p>
        )}
        <Link
          href="/shared"
          onClick={onNavigate}
          className={cn(
            "mt-3 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-text",
            pathname.startsWith("/shared") && "bg-surface-2 text-text",
          )}
        >
          <Share2 className="size-3.5" aria-hidden />
          Shared with me
        </Link>
      </div>

      <div className="mt-2 space-y-0.5 border-t border-border pt-3">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text",
            pathname.startsWith("/settings") && "bg-surface-2 text-text",
          )}
        >
          <Settings className="size-4" aria-hidden />
          Settings
        </Link>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              <ChevronDown className="size-3.5 text-subtle" aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="start" side="top" className="w-56">
            <MenuLabel>{user.email}</MenuLabel>
            <MenuSeparator />
            <MenuItem onSelect={toggle}>
              {dark ? <Sun /> : <Moon />}
              {dark ? "Light theme" : "Dark theme"}
            </MenuItem>
            <MenuItem onSelect={() => router.push("/settings")}>
              <Settings />
              Settings
            </MenuItem>
            {!singleUser && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={signOut}>
                  <LogOut />
                  Sign out
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>
      <CollectionDialog open={newCollection} onOpenChange={setNewCollection} />
    </nav>
  );
}

export function AppShell({
  user,
  singleUser,
  children,
}: {
  user: { name: string; email: string };
  /** Signed in automatically (SINGLE_USER_EMAIL): there is nothing to sign out of. */
  singleUser?: boolean;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The desktop sidebar can be hidden (Ctrl/⌘ + \) to give pages the full width; remembered per browser.
  const [nav, setNav] = usePersistentState("pw-sidebar", "open", ["open", "closed"] as const);
  const navOpen = nav === "open";
  const pathname = usePathname();
  const fullBleed = /^\/papers\/[^/]+\/(read|graph)/.test(pathname) || pathname.startsWith("/graph");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setNav(navOpen ? "closed" : "open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, setNav]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside
        id="app-sidebar"
        inert={!navOpen}
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 overflow-hidden bg-surface-2/40 transition-[width] duration-200 ease-out md:block",
          navOpen ? "w-60 border-r border-border" : "w-0",
        )}
      >
        {/* visibility switches after the width transition, so the content stays visible while it slides. */}
        <div className={cn("h-full w-60 transition-[visibility] duration-200", !navOpen && "invisible")}>
          <Sidebar user={user} singleUser={singleUser} />
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-bg shadow-xl">
            <button
              type="button"
              className="absolute top-4 right-3 rounded-md p-1 text-muted hover:bg-surface-2"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            <Sidebar user={user} singleUser={singleUser} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <MenuIcon />
          </Button>
          <Tooltip content={navOpen ? "Hide sidebar (Ctrl+\\)" : "Show sidebar (Ctrl+\\)"} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={() => setNav(navOpen ? "closed" : "open")}
              aria-label={navOpen ? "Hide sidebar" : "Show sidebar"}
              aria-expanded={navOpen}
              aria-controls="app-sidebar"
            >
              {navOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </Tooltip>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-sm text-subtle shadow-xs hover:border-border-strong"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 truncate">Search your workspace…</span>
            <kbd className="hidden rounded border border-border bg-surface-2 px-1.5 text-[11px] text-muted sm:inline">
              ⌘K
            </kbd>
          </button>
        </header>
        <main id="main" className={cn("flex-1", !fullBleed && "px-4 py-6 md:px-8 md:py-8")}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
