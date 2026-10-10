import { expect, test, type Page } from "@playwright/test";
import { makePdf, signIn, signUp, trackErrors } from "./helpers";

/**
 * The core research loop with AI disabled, using real scholarly data:
 * search → open → save → organize → references/citations → citation graph → discover & save →
 * notes ↔ concepts ↔ papers → knowledge graph → workspace search → PDF reading & highlights →
 * export → access from another device.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let email: string;
let errors: string[];
let paperUrl: string;
let discoveredTitle: string;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  errors = trackErrors(page);
  ({ email } = await signUp(context.request, "Researcher"));
});

test.afterAll(() => {
  expect(errors).toEqual([]);
});

test("search real literature and open a paper", async () => {
  await page.goto("/search");
  await page.getByLabel("Search scholarly literature").fill("attention is all you need");
  await page.getByLabel("Search scholarly literature").press("Enter");
  const result = page.getByRole("link", { name: /^Attention Is All You Need$/i }).first();
  await expect(result).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/results · via/)).toBeVisible();

  // A known identifier opens the paper directly.
  await page.getByLabel("Search scholarly literature").fill("arXiv:1706.03762");
  await page.getByLabel("Search scholarly literature").press("Enter");
  await expect(page).toHaveURL(/\/papers\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  paperUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Attention Is All You Need/i);
  await expect(page.getByText(/dominant sequence transduction/i)).toBeVisible();
  await expect(page.getByText("arXiv", { exact: true }).first()).toBeVisible();
  // Without AI configured the UI explains AI is optional instead of showing broken buttons.
  await expect(page.getByText("AI is optional.")).toBeVisible();
});

test("save, set reading status, tag and add to a collection", async () => {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reading status: Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Reading status: Saved" }).click();
  await page.getByRole("menuitem", { name: "Reading" }).click();
  await expect(page.getByRole("button", { name: "Reading status: Reading" })).toBeVisible();

  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByLabel("Tag name").fill("transformers");
  await page.getByLabel("Tag name").press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "#transformers" })).toBeVisible();

  await page.getByRole("button", { name: "Collections" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "New collection" }).click();
  await page.getByLabel("Name").fill("Thesis");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("main").getByText("Thesis")).toBeVisible();
});

test("inspect references and citations", async () => {
  await page.getByRole("tab", { name: /References/ }).click();
  await expect(page.getByText(/\d+ references · from/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("tabpanel").getByRole("article").first()).toBeVisible();

  await page.getByRole("tab", { name: /Cited by/ }).click();
  await expect(page.getByText(/citing papers · from/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("tabpanel").getByRole("article").first()).toBeVisible();
});

test("find the paper in the library with its organization", async () => {
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByRole("link", { name: /Attention Is All You Need/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reading status: Reading" })).toBeVisible();
  await page
    .getByRole("complementary", { name: "Library filters" })
    .getByRole("link", { name: /transformers/ })
    .click();
  await expect(page.getByRole("heading", { name: "#transformers" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Attention Is All You Need/i })).toBeVisible();
});

test("explore the citation graph and save a discovered paper", async () => {
  await page.goto(`${paperUrl}/graph`);
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "List view" }).click();
  const references = page.locator("section", { has: page.getByRole("heading", { name: /References/ }) }).first();
  const firstUnsaved = references
    .locator("li", { has: page.getByRole("button", { name: "Save", exact: true }) })
    .first();
  discoveredTitle = (await firstUnsaved.getByRole("link").first().textContent())!.trim();
  const item = references.locator("li", { has: page.getByRole("link", { name: discoveredTitle, exact: true }) });
  await item.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item.getByRole("button", { name: "Reading status: Saved" })).toBeVisible();

  await page.goto("/library");
  await expect(page.getByRole("link", { name: discoveredTitle })).toBeVisible();
});

test("write a paper note that creates and links a concept", async () => {
  await page.goto(paperUrl);
  await page.getByRole("link", { name: "Add note" }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await page.getByLabel("Note title").fill("Key ideas");
  await page.getByLabel("Note content").click();
  await page.keyboard.type("Builds on ");
  await page.keyboard.type("[[Self-attention");
  await page.getByRole("option", { name: /Create concept/ }).click();
  await expect(page.getByLabel("Note content").locator(".mention", { hasText: "Self-attention" })).toBeVisible();
  await page.keyboard.type(" for sequence modeling.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("link the paper to the concept and see backlinks", async () => {
  await page.goto(paperUrl);
  await page.getByRole("button", { name: "Link concept" }).first().click();
  await page.getByLabel("Concept name").fill("Self");
  await page.getByRole("button", { name: /Self-attention/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('a.mention[data-type="concept"]', { hasText: "Self-attention" })).toBeVisible();

  await page.locator('a.mention[data-type="concept"]', { hasText: "Self-attention" }).click();
  await expect(page).toHaveURL(/\/concepts\//);
  await expect(page.getByRole("link", { name: /Attention Is All You Need/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Key ideas" })).toBeVisible();
});

test("write a standalone note linking another note", async () => {
  await page.goto("/notes/new");
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await page.getByLabel("Note title").fill("Reading plan");
  await page.getByLabel("Note content").click();
  await page.keyboard.type("Next: ");
  await page.keyboard.type("@Key");
  await page.getByRole("option", { name: /Key ideas/ }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("Note content").locator(".mention", { hasText: "Key ideas" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Key ideas");
  await expect(
    page.getByRole("region", { name: "Backlinks" }).getByRole("link", { name: "Reading plan" }),
  ).toBeVisible();
});

test("notes are block-based: slash menu, to-dos and callouts", async () => {
  await page.goto("/notes/new");
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await page.getByLabel("Note title").fill("Weekly plan");
  await page.getByLabel("Note title").press("Enter");
  await page.keyboard.type("/to-do");
  await expect(page.getByRole("listbox", { name: "Insert a block" })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Re-run the depth baseline");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Remember to compare metric and relative depth.");
  await page.locator('ul[data-type="taskList"] input[type="checkbox"]').first().check();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.locator('ul[data-type="taskList"] li[data-checked="true"]')).toContainText(
    "Re-run the depth baseline",
  );
  await expect(page.getByLabel("Note content").locator("[data-callout]")).toContainText(
    "compare metric and relative depth",
  );
});

test("see the relationships in the knowledge graph", async () => {
  await page.goto("/graph");
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  // Interact with the 3D graph: clicks on nodes and drags must never throw.
  await page.getByRole("button", { name: "3D view" }).click();
  await page.waitForTimeout(2500);
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 25; i++) {
    await page.mouse.click(
      box.x + box.width * (0.3 + (i % 5) * 0.1),
      box.y + box.height * (0.3 + Math.floor(i / 5) * 0.1),
    );
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("link", { name: "Self-attention" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Reading plan" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Key ideas" }).first()).toBeVisible();
});

test("search the personal workspace", async () => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search papers, notes, concepts, highlights…").fill("self-att");
  await expect(page.getByRole("option", { name: /^Self-attention/ })).toBeVisible();
  await page.getByRole("option", { name: /^Self-attention/ }).click();
  await expect(page).toHaveURL(/\/concepts\//);
});

test("upload a PDF, read it and highlight text that persists", async () => {
  await page.goto("/library");
  await page.getByRole("link", { name: discoveredTitle }).click();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "notes.pdf",
      mimeType: "application/pdf",
      buffer: makePdf("Ordinal depth ranking improves relative estimates"),
    });
  await expect(page).toHaveURL(/\/read\?file=/, { timeout: 30_000 });
  const span = page.locator('[data-page-box="1"] .textLayer span').first();
  await expect(span).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "yellow highlight" }).first().click();
  await expect(page.getByText("Highlights (1)")).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-page-box="1"] div[aria-hidden][style*="hl-yellow"]').first()).toBeAttached({
    timeout: 30_000,
  });

  // Ctrl + scroll zooms the document, not the whole page.
  const pdf = page.getByRole("region", { name: "PDF document" });
  const pdfBox = (await pdf.boundingBox())!;
  await page.mouse.move(pdfBox.x + pdfBox.width / 2, pdfBox.y + pdfBox.height / 2);
  await page.keyboard.down("Control");
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(page.getByRole("toolbar", { name: "Reader controls" }).getByText(/^1[3-4]\d%$/)).toBeVisible();
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  await page.getByRole("button", { name: "Fit to width" }).click();
});

test("write a note next to the PDF and quote passages into it", async () => {
  // Still in the reader from the previous test.
  await page.getByRole("tab", { name: /Notes/ }).click();
  await page.getByRole("button", { name: "Start a note on this paper" }).click();
  await page.getByLabel("Note content").click();
  await page.keyboard.type("Reading notes written beside the PDF.");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  const span = page.locator('[data-page-box="1"] .textLayer span').first();
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Add to note" }).click();
  await expect(page.getByLabel("Note content").locator("blockquote")).toContainText("(p. 1)");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  // The paper's graph is docked in the reader and can be minimized and restored.
  await expect(page.getByRole("region", { name: "Paper graph" })).toBeVisible();
  await page.getByRole("button", { name: "Minimize graph" }).click();
  await page.getByRole("button", { name: "Show graph" }).click();
  await expect(page.getByRole("region", { name: "Paper graph" })).toBeVisible();

  // The note persists and is listed on the paper page.
  await page.reload();
  await page.getByRole("tab", { name: /Notes/ }).click();
  await expect(page.getByLabel("Note content")).toContainText("Reading notes written beside the PDF.");
});

test("open a legal open-access PDF in the reader, live at its newest version", async () => {
  await page.goto(paperUrl);
  const fromArxiv = page.waitForRequest(/arxiv\.org\/pdf\/.+v\d+/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page).toHaveURL(/\/read\?file=/, { timeout: 60_000 });
  // The browser loads the PDF from arXiv itself; nothing is stored here.
  await fromArxiv;
  await expect(page.locator('[data-page-box="1"] canvas')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Live · v\d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Versions and storage" }).click();
  await page.getByRole("menuitem", { name: "Check for a newer version" }).click();
  await expect(page.getByText(/This is the newest version \(v\d+\)/)).toBeVisible({ timeout: 30_000 });
});

test("export knowledge in open formats", async () => {
  const json = await page.request.get("/api/export?format=json");
  expect(json.ok()).toBeTruthy();
  const data = await json.json();
  expect(data.papers.map((p: { title: string }) => p.title)).toEqual(
    expect.arrayContaining([expect.stringMatching(/Attention Is All You Need/i)]),
  );
  expect(data.concepts.map((c: { name: string }) => c.name)).toContain("Self-attention");
  expect(data.notes.map((n: { title: string }) => n.title)).toEqual(
    expect.arrayContaining(["Key ideas", "Reading plan"]),
  );
  const md = await page.request.get("/api/export?format=markdown");
  expect(md.headers()["content-type"]).toBe("application/zip");
  const bib = await page.request.get("/api/export?format=bibtex");
  expect(await bib.text()).toContain("eprint = {1706.03762}");
});

test("access the same workspace from another device", async ({ browser }) => {
  const device = await (await browser.newContext()).newPage();
  await signIn(device, email);
  await device.goto("/library");
  await expect(device.getByRole("link", { name: /Attention Is All You Need/i })).toBeVisible();
  await expect(device.getByRole("link", { name: discoveredTitle })).toBeVisible();
  await device.goto("/notes");
  await expect(device.getByRole("link", { name: /Key ideas/ })).toBeVisible();
});
