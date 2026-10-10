"use client";

import { Tabs as T } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => (
  <T.Content className={cn("focus-visible:outline-none data-[state=active]:animate-fade-in", className)} {...p} />
);

export function TabsList({ className, ...p }: ComponentProps<typeof T.List>) {
  return <T.List className={cn("flex items-center gap-1 overflow-x-auto border-b border-border", className)} {...p} />;
}

export function TabsTrigger({ className, ...p }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted transition-[color,border-color] duration-200 hover:text-text",
        "data-[state=active]:border-accent data-[state=active]:text-text [&_svg]:size-4",
        className,
      )}
      {...p}
    />
  );
}
