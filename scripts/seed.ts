/**
 * Creates a demo account with a small, real research workspace (development only).
 *
 *   npm run db:seed
 *
 * Papers are resolved through the real scholarly APIs, so network access is required.
 * Sign in afterwards as demo@paperweave.local / paperweave-demo.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const DEMO_EMAIL = "demo@paperweave.local";
const DEMO_PASSWORD = "paperweave-demo";

const PAPERS = [
  "arXiv:1706.03762", // Attention Is All You Need
  "arXiv:1810.04805", // BERT
  "arXiv:2010.11929", // ViT
  "arXiv:2103.00020", // CLIP
  "arXiv:2401.10891", // Depth Anything
];

async function main() {
  const { eq } = await import("drizzle-orm");
  const { hashPassword } = await import("better-auth/crypto");
  const { closeDb, db } = await import("@/server/db/client");
  const { accounts, users } = await import("@/server/db/schema");
  const { createPersonalWorkspace } = await import("@/server/workspaces");
  const { resolveIdentifier } = await import("@/server/papers/service");
  const { savePaper, setStatus } = await import("@/server/library/library");
  const { addToCollection, createCollection, tagPapers } = await import("@/server/library/organize");
  const { createConcept, linkPaper, relateConcepts } = await import("@/server/knowledge/concepts");
  const { createNote } = await import("@/server/knowledge/notes");

  try {
    const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
    if (existing) {
      console.log(`Demo account already exists (${DEMO_EMAIL}). Nothing to do.`);
      return;
    }

    const userId = randomUUID();
    await db.insert(users).values({ id: userId, name: "Demo Researcher", email: DEMO_EMAIL, emailVerified: true });
    await db.insert(accounts).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(DEMO_PASSWORD),
    });
    const ws = await createPersonalWorkspace(userId, "Demo Researcher");
    const ctx = {
      userId,
      userName: "Demo Researcher",
      userEmail: DEMO_EMAIL,
      workspaceId: ws.id,
      role: "owner" as const,
    };

    const paperIds: string[] = [];
    for (const id of PAPERS) {
      try {
        const paperId = await resolveIdentifier(id);
        if (paperId) {
          await savePaper(ws.id, userId, paperId);
          paperIds.push(paperId);
          console.log(`  saved ${id}`);
        }
      } catch (err) {
        console.warn(`  could not resolve ${id}: ${(err as Error).message}`);
      }
    }
    if (!paperIds.length) throw new Error("No papers could be resolved — check network access to the scholarly APIs.");

    await setStatus(ws.id, paperIds.slice(0, 2), "read");
    await setStatus(ws.id, paperIds.slice(2, 3), "reading");
    const collection = await createCollection(ws.id, { name: "Foundations of multimodal models" });
    await addToCollection(ws.id, userId, collection.id, paperIds);
    await tagPapers(ws.id, userId, paperIds.slice(0, 3), { names: ["transformers"] });

    const attention = await createConcept(ctx, {
      name: "Self-attention",
      description: "Each token attends to every other token; the core operation of the Transformer.",
      aliases: ["scaled dot-product attention"],
    });
    const contrastive = await createConcept(ctx, {
      name: "Contrastive pre-training",
      description: "Learning aligned representations by pulling matching pairs together and pushing others apart.",
    });
    await relateConcepts(ctx, attention.id, contrastive.id, true);
    for (const id of paperIds.slice(0, 3)) await linkPaper(ctx, attention.id, id);
    if (paperIds[3]) await linkPaper(ctx, contrastive.id, paperIds[3]);

    await createNote(ctx, {
      title: "Reading plan",
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why these papers" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Start with " },
              { type: "mention", attrs: { id: `concept:${attention.id}`, label: "Self-attention" } },
              { type: "text", text: ", then follow how vision models adopted it and how " },
              { type: "mention", attrs: { id: `concept:${contrastive.id}`, label: "Contrastive pre-training" } },
              { type: "text", text: " connects images and text." },
            ],
          },
        ],
      },
    });
    console.log(`\nDemo workspace ready. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
