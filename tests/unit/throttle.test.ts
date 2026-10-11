import { describe, expect, it } from "vitest";
import { runInBackground, Throttle } from "@/server/scholarly/http";

describe("request pacing", () => {
  it("lets the user's requests go ahead of background work", async () => {
    const throttle = new Throttle(100);
    const order: string[] = [];
    await throttle.wait(); // the user just searched
    const job = runInBackground(async () => {
      await throttle.wait();
      order.push("job");
    });
    await new Promise((r) => setTimeout(r, 50));
    await throttle.wait(); // the user's next request, while the job is waiting
    order.push("user");
    await job;
    expect(order).toEqual(["user", "job"]);
  });

  it("keeps the minimum interval between requests", async () => {
    const throttle = new Throttle(80);
    const start = Date.now();
    await throttle.wait();
    await throttle.wait();
    await throttle.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });
});
