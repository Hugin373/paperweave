import { describe, expect, it } from "vitest";
import { sameSite } from "@/proxy";

describe("cross-site request check", () => {
  const allowed = new Set(["http://localhost:3300", "https://my-pc.tail1234.ts.net"]);

  it("accepts the instance's own addresses and the host the request was sent to", () => {
    expect(sameSite("http://localhost:3300", "localhost:3300", allowed)).toBe(true);
    expect(sameSite("https://my-pc.tail1234.ts.net", "127.0.0.1:3300", allowed)).toBe(true);
    expect(sameSite("http://127.0.0.1:3300", "127.0.0.1:3300", allowed)).toBe(true);
  });

  it("blocks other websites", () => {
    expect(sameSite("https://evil.example.com", "localhost:3300", allowed)).toBe(false);
    expect(sameSite("http://127.0.0.1:3300", "localhost:3300", allowed)).toBe(false);
    expect(sameSite("null", "localhost:3300", allowed)).toBe(false);
    expect(sameSite("http://localhost:3301", null, allowed)).toBe(false);
  });
});
