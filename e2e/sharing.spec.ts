import { expect, test } from "@playwright/test";
import { BASE_URL, signIn, signUp } from "./helpers";

test("share a note with another user and by public link; private data stays private", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signUp(ownerCtx.request, "Owner");
  const readerCtx = await browser.newContext();
  const reader = await readerCtx.newPage();
  const readerAccount = await signUp(readerCtx.request, "Reader");

  // Owner writes a note.
  await owner.goto("/notes/new");
  await expect(owner).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  const noteUrl = new URL(owner.url()).pathname;
  await owner.getByLabel("Note title").fill("Lab meeting summary");
  await owner.getByLabel("Note content").click();
  await owner.keyboard.type("Depth models generalize poorly outdoors.");
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Before sharing, the reader cannot see it (UI and API).
  const forbidden = await readerCtx.request.get(`/api${noteUrl}`);
  expect(forbidden.status()).toBe(404);

  // Share view-only with the reader and create a public link.
  await owner.getByRole("button", { name: "Share" }).click();
  await owner.getByLabel("Email address to share with").fill(readerAccount.email);
  await owner.getByRole("button", { name: "Invite" }).click();
  await expect(owner.getByRole("dialog").getByText(readerAccount.email)).toBeVisible();
  await owner.getByRole("button", { name: "Create link" }).click();
  const linkInput = owner.getByLabel("Public link");
  await expect(linkInput).toHaveValue(/\/s\//);
  const publicUrl = new URL(await linkInput.inputValue());

  // The reader finds it under "Shared with me" and gets a read-only view.
  await reader.goto("/shared");
  await reader.getByRole("link", { name: "Lab meeting summary" }).click();
  await expect(reader.getByText(/view only/)).toBeVisible();
  await expect(reader.getByLabel("Note content")).toHaveAttribute("contenteditable", "false");
  const edit = await readerCtx.request.patch(`/api${noteUrl}`, {
    data: { title: "Hijacked" },
    headers: { origin: BASE_URL },
  });
  expect(edit.status()).toBe(403);

  // Anyone with the public link can read it without signing in.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(publicUrl.pathname);
  await expect(anon.getByRole("heading", { name: "Lab meeting summary" })).toBeVisible();
  await expect(anon.getByText("Depth models generalize poorly outdoors.")).toBeVisible();

  // Signing in again as the reader on another device keeps the share.
  const device = await (await browser.newContext()).newPage();
  await signIn(device, readerAccount.email);
  await device.goto("/shared");
  await expect(device.getByRole("link", { name: "Lab meeting summary" })).toBeVisible();
});
