/**
 * Outbound HTTP for URLs that come from users or third parties (PDF links, custom AI
 * endpoints). Blocks requests to private, loopback and link-local networks to prevent SSRF,
 * re-validating every redirect hop. The address check also runs when the connection is opened, on the
 * address actually connected to, so a host cannot pass the check and then resolve somewhere private.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const v4At = (i: number) => `${h[i] >> 8}.${h[i] & 255}.${h[i + 1] >> 8}.${h[i + 1] & 255}`;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  // Unspecified, loopback, and IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4).
  if (zeros(0, 7) && h[7] <= 1) return true;
  if (zeros(0, 5) && (h[5] === 0xffff || h[5] === 0)) return isPrivateAddress(v4At(6));
  if (h[0] === 0x64 && h[1] === 0xff9b) return zeros(2, 6) ? isPrivateAddress(v4At(6)) : true;
  if (h[0] === 0x2002) return isPrivateAddress(v4At(1));
  // Teredo (2001::/32) hides an IPv4 address; documentation (2001:db8::/32).
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8.
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || h[0] >= 0xff00;
}

/** Expands an IPv6 address (including a trailing dotted IPv4 part) to eight 16-bit groups. */
function ipv6Hextets(ip: string): number[] | null {
  let v6 = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const n = ipv4ToInt(dotted[1]);
    v6 = `${v6.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = v6.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":").map((x) => parseInt(x, 16)) : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<number>(fill).fill(0), ...tail];
  return all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("The URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http(s) URLs are allowed.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("Private network addresses are not allowed.");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new UnsafeUrlError("The host could not be resolved.");
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("Private network addresses are not allowed.");
  }
  return url;
}

type Resolver = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, (err, addresses) => callback(err, addresses ?? []));

/**
 * A `net.connect` lookup function that refuses private addresses. Connections go to the address it
 * returns, so the check and the connection cannot disagree (no DNS rebinding between them).
 */
export function publicOnlyLookup(resolve: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err, "");
      if (!addresses.length) return callback(new UnsafeUrlError("The host could not be resolved."), "");
      if (addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(new UnsafeUrlError("Private network addresses are not allowed."), "");
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const g = globalThis as unknown as { __pwPublicAgent?: Agent };
const publicAgent = () => (g.__pwPublicAgent ??= new Agent({ connect: { lookup: publicOnlyLookup() } }));

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  allowPrivate?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { allowPrivate = false, maxRedirects = 5, timeoutMs = 30000, ...init } = opts;
  let current = raw;
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!allowPrivate) await assertPublicUrl(current);
    const res = await fetch(current, {
      ...init,
      signal,
      redirect: "manual",
      ...(allowPrivate ? {} : { dispatcher: publicAgent() }),
    } as RequestInit).catch((err: unknown) => {
      // A refusal from the connection-time check arrives wrapped in fetch's generic error.
      const cause = err instanceof Error ? err.cause : null;
      throw cause instanceof UnsafeUrlError ? cause : err;
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError("Too many redirects.");
}

/** Reads a response body, aborting once it exceeds `maxBytes`. */
export async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > maxBytes) throw new UnsafeUrlError("The file is too large.");
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnsafeUrlError("The file is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
