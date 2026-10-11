import { describe, expect, it } from "vitest";
import { ASSISTANT_CAPABILITIES, INTERNAL_ASSISTANT_TOOLS } from "@/lib/assistant-capabilities";
import { READ_TOOLS } from "@/server/research/agent";
import { CHANGE_TOOLS } from "@/server/research/changes";

describe("the 'What can the Assistant do?' list", () => {
  const listed = new Set(ASSISTANT_CAPABILITIES.flatMap((c) => c.items.flatMap((i) => i.tools)));

  it("mentions every tool the assistant has", () => {
    const all = [...READ_TOOLS, ...CHANGE_TOOLS].filter((t) => !INTERNAL_ASSISTANT_TOOLS.includes(t));
    expect(all.filter((t) => !listed.has(t))).toEqual([]);
  });

  it("mentions only tools that exist", () => {
    const exists = new Set([...READ_TOOLS, ...CHANGE_TOOLS]);
    expect([...listed].filter((t) => !exists.has(t))).toEqual([]);
  });
});
