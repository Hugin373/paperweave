import { afterAll, describe, expect, it, vi } from "vitest";
import { isOwnHost } from "@/server/single-user";
import { createUser } from "./helpers";

describe("single-user mode", () => {
  afterAll(() => {
    delete process.env.SINGLE_USER_EMAIL;
    delete process.env.TRUSTED_ORIGINS;
    vi.resetModules();
  });

  it("accepts only hosts this instance is opened at", () => {
    const origins = ["http://localhost:3300", "https://my-pc.tail1234.ts.net"];
    expect(isOwnHost("localhost:3300", origins)).toBe(true);
    expect(isOwnHost("127.0.0.1:3300", origins)).toBe(true);
    expect(isOwnHost("[::1]:3300", origins)).toBe(true);
    expect(isOwnHost("my-pc.tail1234.ts.net", origins)).toBe(true);
    // A website pointing its own domain at this computer (DNS rebinding).
    expect(isOwnHost("evil.example.com:3300", origins)).toBe(false);
    expect(isOwnHost("localhost.evil.example.com", origins)).toBe(false);
    expect(isOwnHost(null, origins)).toBe(false);
    expect(isOwnHost("bad host/", origins)).toBe(false);
  });

  it("signs in the configured account for its own hosts only", async () => {
    const owner = await createUser("Owner");
    await createUser("Someone else");
    process.env.SINGLE_USER_EMAIL = owner.userEmail.toUpperCase();
    process.env.TRUSTED_ORIGINS = "https://my-pc.tail1234.ts.net";
    vi.resetModules(); // the environment is read once per module instance
    const { singleUser } = await import("@/server/single-user");
    expect(await singleUser("localhost:3300")).toEqual({ id: owner.userId, name: "Owner", email: owner.userEmail });
    expect((await singleUser("my-pc.tail1234.ts.net"))?.id).toBe(owner.userId);
    expect(await singleUser("evil.example.com")).toBeNull();
  });

  it("signs in nobody when the email matches no account, or the mode is off", async () => {
    process.env.SINGLE_USER_EMAIL = "nobody@example.com";
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await (await import("@/server/single-user")).singleUser("localhost:3300")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    delete process.env.SINGLE_USER_EMAIL;
    vi.resetModules();
    expect(await (await import("@/server/single-user")).singleUser("localhost:3300")).toBeNull();
  });
});
