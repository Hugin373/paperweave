import { beforeAll, describe, expect, it } from "vitest";
import { createConcept, getConceptDetail, updateConcept } from "@/server/knowledge/concepts";
import { createNote, deleteNote, getNoteDetail, updateNote } from "@/server/knowledge/notes";
import { addToCollection, createCollection } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { requireAccess } from "@/server/sharing/access";
import { publicShare } from "@/server/sharing/public";
import {
  collectionView,
  createShare,
  deleteShare,
  leaveShare,
  listShares,
  sharedWithMe,
} from "@/server/sharing/shares";
import { createUser, paper } from "./helpers";

describe("sharing and permissions", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let reader: Awaited<ReturnType<typeof createUser>>;
  let stranger: Awaited<ReturnType<typeof createUser>>;
  let noteId: string;

  beforeAll(async () => {
    owner = await createUser("Owner");
    reader = await createUser("Reader");
    stranger = await createUser("Stranger");
    noteId = (await createNote(owner, { title: "Shared thoughts" })).id;
  });

  it("hides private notes from other users", async () => {
    await expect(getNoteDetail(stranger, noteId)).rejects.toMatchObject({ status: 404 });
    await expect(updateNote(stranger, noteId, { title: "hacked" })).rejects.toMatchObject({ status: 404 });
  });

  it("grants view access by email and enforces read-only", async () => {
    const share = await createShare(owner, {
      resourceType: "note",
      resourceId: noteId,
      email: reader.userEmail.toUpperCase(),
      permission: "view",
    });
    expect(share.grantee?.id).toBe(reader.userId);
    const seen = await getNoteDetail(reader, noteId);
    expect(seen.access).toBe("view");
    expect(seen.ownerName).toBe("Owner");
    await expect(updateNote(reader, noteId, { title: "nope" })).rejects.toMatchObject({ status: 403 });
    expect((await sharedWithMe(reader)).map((s) => s.title)).toEqual(["Shared thoughts"]);
    // Only the owner can manage shares.
    await expect(listShares(reader, "note", noteId)).rejects.toMatchObject({ status: 403 });
    await expect(deleteShare(reader, share.id)).rejects.toMatchObject({ status: 404 });
  });

  it("upgrades to edit access", async () => {
    await createShare(owner, { resourceType: "note", resourceId: noteId, email: reader.userEmail, permission: "edit" });
    await updateNote(reader, noteId, { title: "Edited together" });
    expect((await getNoteDetail(owner, noteId)).title).toBe("Edited together");
    await expect(deleteNote(reader, noteId)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects unknown emails and self-shares", async () => {
    await expect(
      createShare(owner, { resourceType: "note", resourceId: noteId, email: "nobody@example.com", permission: "view" }),
    ).rejects.toThrow(/No Paperweave account/);
    await expect(
      createShare(owner, { resourceType: "note", resourceId: noteId, email: owner.userEmail, permission: "view" }),
    ).rejects.toThrow(/already has access/);
  });

  it("supports view-only public links", async () => {
    const link = await createShare(owner, { resourceType: "note", resourceId: noteId, permission: "edit", link: true });
    expect(link.permission).toBe("view");
    const token = link.linkUrl!.split("/s/")[1];
    const pub = await publicShare(token);
    expect(pub.type).toBe("note");
    await deleteShare(owner, link.id);
    await expect(publicShare(token)).rejects.toMatchObject({ status: 404 });
  });

  it("shares collections; editors change the owner's collection", async () => {
    const coll = await createCollection(owner.workspaceId, { name: "Shared reading" });
    const [p1, p2] = await ingestPapers([
      paper({ title: "Shared paper one", ids: { s2: "sh-1" } }),
      paper({ title: "Shared paper two", ids: { s2: "sh-2" } }),
    ]);
    await addToCollection(owner.workspaceId, owner.userId, coll.id, [p1]);
    await expect(
      requireAccess(reader, "collection", coll.id, owner.workspaceId, "view", "Collection"),
    ).rejects.toMatchObject({ status: 404 });

    await createShare(owner, {
      resourceType: "collection",
      resourceId: coll.id,
      email: reader.userEmail,
      permission: "edit",
    });
    const access = await requireAccess(reader, "collection", coll.id, owner.workspaceId, "edit", "Collection");
    expect(access).toBe("edit");
    await addToCollection(owner.workspaceId, reader.userId, coll.id, [p2]);
    const view = await collectionView(coll.id, reader.workspaceId, access);
    expect(view.papers.map((p) => p.title).sort()).toEqual(["Shared paper one", "Shared paper two"]);
    expect(view.papers.every((p) => p.library === null)).toBe(true);
  });

  it("lets concept editors change the description but not rename", async () => {
    const concept = await createConcept(owner, { name: "Centiloid" });
    await createShare(owner, {
      resourceType: "concept",
      resourceId: concept.id,
      email: reader.userEmail,
      permission: "edit",
    });
    await updateConcept(reader, concept.id, { description: "A standardized amyloid PET scale." });
    await expect(updateConcept(reader, concept.id, { name: "Renamed" })).rejects.toThrow(/owner/);
    expect((await getConceptDetail(reader, concept.id)).description).toBe("A standardized amyloid PET scale.");
  });

  it("lets grantees leave a share", async () => {
    const items = await sharedWithMe(reader);
    await leaveShare(reader, items[0].shareId);
    expect((await sharedWithMe(reader)).length).toBe(items.length - 1);
    await expect(leaveShare(stranger, items[1].shareId)).rejects.toMatchObject({ status: 404 });
  });
});
