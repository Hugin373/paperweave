import { ViewTransition, type ReactNode } from "react";

/**
 * Re-mounted on every navigation (unlike the layout), so each page can animate in: the old page fades
 * out quickly and the new one rises in (the `.page` view transition in globals.css). Browsers without
 * view transitions simply switch pages.
 */
export default function Template({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="page" exit="page" default="none">
      {children}
    </ViewTransition>
  );
}
