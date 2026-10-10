import { describe, expect, it } from "vitest";
import { backupName, backupsToPrune, dockerNetwork, pgEnv } from "../../scripts/backup.mjs";

describe("backup script helpers", () => {
  it("passes the connection as libpq variables (no password on a command line)", () => {
    // A made-up connection, assembled here so no credential-like URL is written in the repository.
    const url = new URL("postgresql://db.example.com/main?sslmode=require");
    url.username = "user";
    url.password = "p@ss";
    expect(pgEnv(url.toString())).toEqual({
      PGHOST: "db.example.com",
      PGPORT: "5432",
      PGUSER: "user",
      PGPASSWORD: "p@ss",
      PGDATABASE: "main",
      PGSSLMODE: "require",
    });
  });

  it("names backups by local time", () => {
    expect(backupName(new Date(2026, 9, 10, 9, 5))).toBe("paperweave-2026-10-10-0905.dump");
  });

  it("removes only its own oldest backups beyond the number to keep", () => {
    const names = [
      "paperweave-2026-10-01-1200.dump",
      "paperweave-2026-10-08-1200.dump",
      "paperweave-2026-10-10-0905.dump",
      "my-notes.dump",
      "files",
    ];
    expect(backupsToPrune(names, 2)).toEqual(["paperweave-2026-10-01-1200.dump"]);
    // At least one backup always stays.
    expect(backupsToPrune(names, 0)).toEqual(["paperweave-2026-10-08-1200.dump", "paperweave-2026-10-01-1200.dump"]);
  });

  it("lets pg_dump in Docker reach a database on this computer", () => {
    const local = { PGHOST: "localhost", PGPORT: "5433" };
    expect(dockerNetwork(local, "linux")).toEqual({ args: ["--network", "host"], env: local });
    expect(dockerNetwork(local, "darwin")).toEqual({
      args: [],
      env: { PGHOST: "host.docker.internal", PGPORT: "5433" },
    });
    const cloud = { PGHOST: "db.example.com", PGPORT: "5432" };
    expect(dockerNetwork(cloud, "linux")).toEqual({ args: [], env: cloud });
  });
});
