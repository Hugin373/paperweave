import { describe, expect, it } from "vitest";
import { postgresUrl } from "@/server/db/url";

describe("database connection strings", () => {
  it("drops libpq-only options that postgres.js would send to the server", () => {
    expect(
      postgresUrl("postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"),
    ).toBe("postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require");
    expect(postgresUrl("postgres://u:p@localhost:5433/db")).toBe("postgres://u:p@localhost:5433/db");
  });
});
