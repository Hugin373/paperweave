import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

/**
 * Renders Markdown safely (raw HTML is not rendered). `renderLink` can replace particular links
 * (e.g. citation chips); returning undefined falls back to a normal external link.
 */
export function Markdown({
  children,
  className,
  renderLink,
}: {
  children: string;
  className?: string;
  renderLink?: (href: string, children: ReactNode) => ReactNode | undefined;
}) {
  return (
    <div className={cn("prose-content text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, href, children: content, ...props }) =>
            (href && renderLink?.(href, content)) ?? (
              <a href={href} {...props} target="_blank" rel="noreferrer noopener">
                {content}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
