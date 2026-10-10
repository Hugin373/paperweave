import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agent } from "undici";
import { assertPublicUrl, isPrivateAddress, publicOnlyLookup, UnsafeUrlError } from "@/server/net/safe-fetch";
import { parseRange } from "@/server/files/storage";
import { isPdf } from "@/server/files/service";

describe("SSRF protection", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a01:203",
    "::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:101::1",
    "2001::1",
    "ff02::1",
    "::",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "140.82.112.3", "2606:4700::1111", "::ffff:808:808", "2002:808:808::1"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it("rejects private, local and non-http URLs", async () => {
    for (const url of [
      "http://localhost:3000/x",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]:8080/",
      "http://[::ffff:169.254.169.254]/latest",
      "file:///etc/passwd",
      "http://user:pw@example.com",
      "http://169.254.169.254/latest",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it("accepts public literal addresses", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });

  it("checks the address actually connected to (no DNS rebinding)", async () => {
    const server = createServer((_req, res) => res.end("private"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    // The name "resolves" to loopback only at connection time, after any earlier check.
    const agent = new Agent({
      connect: { lookup: publicOnlyLookup((_host, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])) },
    });
    try {
      const err = await fetch(`http://rebind.example:${port}/`, { dispatcher: agent } as RequestInit).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(UnsafeUrlError);
    } finally {
      await agent.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("HTTP range parsing", () => {
  it("parses single ranges", () => {
    expect(parseRange("bytes=0-99")).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-")).toEqual({ start: 100, end: undefined });
    expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=1-2,4-5")).toBeUndefined();
    expect(parseRange(null)).toBeUndefined();
  });
});

describe("PDF validation", () => {
  it("checks magic bytes", () => {
    expect(isPdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
    expect(isPdf(new TextEncoder().encode("<html>not a pdf</html>"))).toBe(false);
  });
});
