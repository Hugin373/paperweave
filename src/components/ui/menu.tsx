"use client";

import { DropdownMenu as M, Popover as P, Tooltip as T } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

const panel = "z-50 rounded-lg border border-border bg-surface p-1 shadow-lg text-sm";
/** Grow from where the panel was opened, and shrink back when it closes. */
const motion = "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuSub = M.Sub;
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => (
  <M.Label className={cn("px-2 py-1.5 text-xs font-medium text-subtle", className)} {...p} />
);
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-border" />;

export function MenuContent({ className, align = "end", ...p }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        className={cn(panel, motion, "min-w-44 origin-(--radix-dropdown-menu-content-transform-origin)", className)}
        {...p}
      />
    </M.Portal>
  );
}

const itemCls =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted";

export function MenuItem({ className, danger, ...p }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return <M.Item className={cn(itemCls, danger && "text-danger [&_svg]:text-danger", className)} {...p} />;
}

export function MenuCheckboxItem({ className, children, ...p }: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn(itemCls, "relative pl-7", className)} {...p}>
      <M.ItemIndicator className="absolute left-2 text-accent">✓</M.ItemIndicator>
      {children}
    </M.CheckboxItem>
  );
}

export function MenuSubTrigger({ className, ...p }: ComponentProps<typeof M.SubTrigger>) {
  return <M.SubTrigger className={cn(itemCls, className)} {...p} />;
}

export function MenuSubContent({ className, ...p }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={6}
        className={cn(panel, motion, "min-w-44 origin-(--radix-dropdown-menu-content-transform-origin)", className)}
        {...p}
      />
    </M.Portal>
  );
}

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;
export function PopoverContent({ className, align = "start", ...p }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={6}
        className={cn(panel, motion, "w-72 origin-(--radix-popover-content-transform-origin) p-3", className)}
        {...p}
      />
    </P.Portal>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={5}
          className="z-50 origin-(--radix-tooltip-content-transform-origin) animate-scale-in rounded-md bg-text px-2 py-1 text-xs text-bg shadow"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;
