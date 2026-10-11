import { z } from "zod";

export const clientErrorSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  digest: z.string().max(200).optional(),
  url: z.string().max(1000).optional(),
});

/**
 * Writes an error a browser hit while showing a page to the server log, so errors on devices without
 * developer tools (phones) can be diagnosed: `journalctl --user -u paperweave` or the server output.
 */
export function logClientError(report: z.infer<typeof clientErrorSchema>, userAgent: string | null) {
  const where = report.url ? new URL(report.url, "http://x").pathname : "?";
  console.error(
    `[client error] ${where} — ${report.message}\n  browser: ${(userAgent ?? "unknown").slice(0, 300)}` +
      (report.digest ? `\n  digest: ${report.digest}` : "") +
      (report.stack ? `\n  ${report.stack.split("\n").slice(0, 12).join("\n  ")}` : ""),
  );
}
