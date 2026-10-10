import { beforeAll, describe, expect, it } from "vitest";
import { snippetParts } from "@/lib/format";
import { toPrefixQuery } from "@/server/search/workspace-search";

describe("workspace search queries", () => {
  it("builds prefix tsqueries from free text safely", () => {
    expect(toPrefixQuery("Metric depth")).toBe("metric:* & depth:*");
    expect(toPrefixQuery("vision-language 3D")).toBe("vision:* & language:* & 3d:*");
    expect(toPrefixQuery("'); drop table notes; --")).toBe("drop:* & table:* & notes:*");
    expect(toPrefixQuery("   ")).toBeNull();
    expect(toPrefixQuery("Größe")).toBe("große:*");
  });

  it("splits highlighted snippets for rendering", () => {
    expect(snippetParts("a ⟦b⟧ c")).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
      { text: " c", hit: false },
    ]);
  });
});

describe("secret encryption", () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.BETTER_AUTH_SECRET ??= "unit-test-secret-unit-test-secret-1234";
  });

  it("round-trips and detects tampering", async () => {
    const { encryptSecret, decryptSecret } = await import("@/server/crypto");
    const enc = encryptSecret("sk-test-123");
    expect(enc).not.toContain("sk-test");
    expect(decryptSecret(enc)).toBe("sk-test-123");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("collection colors", () => {
  it("uses the chosen color, or a stable automatic one", async () => {
    const { collectionColor, COLLECTION_COLORS } = await import("@/lib/collection-colors");
    expect(collectionColor({ id: "a", color: "#123456" })).toBe("#123456");
    const auto = collectionColor({ id: "9b1c0f0e-1111-4222-8333-444455556666", color: null });
    expect(auto).toMatch(/^#[0-9a-f]{6}$/);
    expect(collectionColor({ id: "9b1c0f0e-1111-4222-8333-444455556666", color: null })).toBe(auto);
    expect(COLLECTION_COLORS.length).toBeGreaterThan(5);
    // Colors from the earlier palette show as their closest current color.
    expect(collectionColor({ id: "a", color: "#3150C9" })).toBe("#5889e6");
  });

  it("gives new collections the least-used color", async () => {
    const { nextCollectionColor, AUTO_COLOR_ORDER, COLLECTION_COLORS } = await import("@/lib/collection-colors");
    expect(new Set(AUTO_COLOR_ORDER)).toEqual(new Set(COLLECTION_COLORS));
    expect(nextCollectionColor([])).toBe(AUTO_COLOR_ORDER[0]);
    expect(nextCollectionColor([AUTO_COLOR_ORDER[0], null, "#123456"])).toBe(AUTO_COLOR_ORDER[1]);
    expect(nextCollectionColor(["#3150c9", AUTO_COLOR_ORDER[1]])).toBe(AUTO_COLOR_ORDER[2]);
    expect(nextCollectionColor(AUTO_COLOR_ORDER)).toBe(AUTO_COLOR_ORDER[0]);
  });
});

describe("graph node colors", () => {
  it("uses one rule set for the 2D and 3D views", async () => {
    const { nodeFill, nodeRing } = await import("@/components/graph/graph-style");
    const t = {
      paper: "P",
      concept: "C",
      note: "N",
      accent: "A",
      subtle: "S",
      borderStrong: "B",
      warning: "W",
    } as unknown as Parameters<typeof nodeFill>[1];
    expect(nodeFill({ type: "paper" }, t)).toBe("P");
    expect(nodeFill({ type: "concept" }, t)).toBe("C");
    expect(nodeFill({ type: "paper", role: "center" }, t)).toBe("A");
    expect(nodeFill({ type: "paper", role: "citation" }, t)).toBe("N");
    expect(nodeFill({ type: "paper", role: "expanded" }, t)).toBe("S");
    expect(nodeFill({ type: "paper", role: "center", color: "#5889e6" }, t)).toBe("#5889e6");
    expect(nodeFill({ type: "note", color: "dim" }, t)).toBe("B");
    expect(nodeRing({ status: "saved" }, t)).toBeNull();
    expect(nodeRing({ role: "reference", status: "saved" }, t)).toBe("W");
    expect(nodeRing({ ring: "#e78537" }, t)).toBe("#e78537");
  });
});

describe("page links in answers", () => {
  it("links a page right after a paper citation, and leaves other text alone", async () => {
    const { linkCitations } = await import("@/lib/research-sources");
    expect(linkCitations("Shown in [P3] (p. 5) and [P1, N2]. See (p. 9).")).toBe(
      "Shown in [P3](#cite-P3) [(p. 5)](#page-P3-5) and [P1](#cite-P1)[N2](#cite-N2). See (p. 9).",
    );
    expect(linkCitations("[P2] (pp. 4–6)")).toBe("[P2](#cite-P2) [(pp. 4–6)](#page-P2-4)");
  });
});
