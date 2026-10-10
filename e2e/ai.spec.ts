import { expect, test } from "@playwright/test";
import { signUp, trackErrors } from "./helpers";

/** AI is configured with the deterministic mock provider (enabled only on the test server). */
test("configure an AI provider and use it for search, reading and notes", async ({ page, context }) => {
  const errors = trackErrors(page);
  await signUp(context.request, "AiUser");

  await page.goto("/settings?tab=ai");
  await expect(page.getByText("Not configured")).toBeVisible();
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Mock/)).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected to mock-1" })).toBeVisible();

  // AI-assisted search: the question is rewritten, then normal scholarly search runs.
  await page.goto("/search");
  await page
    .getByLabel("Search scholarly literature")
    .fill("How do vision-language models understand spatial relationships?");
  await page.getByRole("button", { name: "Turn question into a search with AI" }).click();
  await expect(page.getByText("AI rewrote your question")).toBeVisible({ timeout: 45_000 });

  // AI on a paper: summary is generated, labeled and stored.
  await page.getByLabel("Search scholarly literature").fill("arXiv:1706.03762");
  await page.getByLabel("Search scholarly literature").press("Enter");
  await expect(page).toHaveURL(/\/papers\//, { timeout: 45_000 });
  await page.getByRole("button", { name: "Generate summary" }).click();
  await expect(page.getByText(/AI-generated/).first()).toBeVisible();
  await expect(page.getByText(/\[mock\]/).first()).toBeVisible();
  // The summary is stored once it has finished streaming (the stored version shows "Regenerate").
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText(/\[mock\]/).first()).toBeVisible();
  // It says what it read: the open-access copy from arXiv (or only the abstract if that is unreachable).
  await expect(page.getByText(/^Read the (full text|title and abstract)/)).toBeVisible();

  // Ask about the paper.
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByLabel("Ask a question about this paper").fill("What is the main contribution?");
  await page.getByLabel("Ask a question about this paper").press("Enter");
  await expect(page.getByText(/\[mock\].*main contribution/).first()).toBeVisible();
  await expect(page.getByText(/^Read (pages?|the title and abstract)/)).toBeVisible();

  // The assistant in the reader: questions carry the page on screen, and the conversation is kept.
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page).toHaveURL(/\/read\?file=/, { timeout: 60_000 });
  await page.getByRole("tab", { name: "AI" }).click();
  const sidebar = page.getByRole("complementary", { name: "Reader sidebar" });
  await expect(sidebar.getByText("Page 1", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Explain what is on this page" }).click();
  await expect(sidebar.getByText(/\[mock\] Research report based on/)).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.getByText(/^p\. 1 · Chat$/)).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "AI" }).click();
  await expect(sidebar.getByText(/^p\. 1 · Chat$/)).toBeVisible();

  // Selecting text offers Explain (fully visible, inside the viewer), which asks in the same chat.
  const word = page
    .locator('[data-page-box="1"] .textLayer span')
    .filter({ hasText: /\w{4,}/ })
    .nth(3);
  const box = (await word.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const menu = page.getByRole("dialog", { name: "Selection actions" });
  const explain = menu.getByRole("button", { name: "Explain" });
  await expect(explain).toBeVisible();
  const [m, viewer] = [
    await menu.boundingBox(),
    await page.getByRole("region", { name: "PDF document" }).boundingBox(),
  ];
  expect(m!.x).toBeGreaterThanOrEqual(viewer!.x);
  expect(m!.x + m!.width).toBeLessThanOrEqual(viewer!.x + viewer!.width);
  await explain.click();
  await expect(sidebar.getByText(/Explain this passage: what it says/)).toBeVisible();
  await expect(sidebar.locator("blockquote")).toBeVisible();

  // AI note assistance never replaces the user's text.
  await page.goto("/notes/new");
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await page.getByLabel("Note content").click();
  await page.keyboard.type("Transformers replace recurrence with attention.");
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Summarize" }).click();
  await expect(page.getByText(/\[mock\]/).first()).toBeVisible();
  await expect(page.getByLabel("Note content")).toContainText("Transformers replace recurrence with attention.");

  expect(errors).toEqual([]);
});

test("AI failures are explained and do not break the app", async ({ page, context }) => {
  await signUp(context.request, "AiFail");
  await page.goto("/settings?tab=ai");
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByLabel("Model").fill("fail");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("The mock provider was asked to fail.")).toBeVisible();

  // Removing the provider returns the app to the AI-free experience.
  await page.getByRole("button", { name: "Remove provider" }).click();
  await expect(page.getByText("Not configured")).toBeVisible();
  await page.goto("/search?q=arXiv%3A1706.03762");
  await expect(page).toHaveURL(/\/papers\//, { timeout: 45_000 });
  await expect(page.getByText("AI is optional.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate summary/ })).toHaveCount(0);
});

test("deep research from the search page: live steps, cited report, follow-up, save as note", async ({
  page,
  context,
}) => {
  const errors = trackErrors(page);
  await signUp(context.request, "Researcher");
  await page.goto("/settings?tab=ai");
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Mock/)).toBeVisible();

  await page.goto("/search");
  await page.getByLabel("Search scholarly literature").fill("What is known about attention in transformers?");
  await page.getByRole("button", { name: "Deep research with AI" }).click();
  await expect(page).toHaveURL(/\/research\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "What is known about attention in transformers?" })).toBeVisible();

  // The report cites real papers found by the search step; citations are links to the papers.
  await expect(page.getByText(/\[mock\] Research report based on/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /Researched for .* · 2 steps/ })).toBeVisible();
  const chip = page.locator("article a.cite-chip").first();
  await expect(chip).toHaveAttribute("href", /\/papers\/[0-9a-f-]{36}/);
  // The AI ranks the cited papers: a reading order first, then priorities.
  const sources = page.getByRole("region", { name: "Sources" });
  await expect(sources.getByText(/^Ranked by AI/)).toBeVisible();
  await expect(sources.getByRole("heading", { name: "Start here" })).toBeVisible();
  await expect(sources.getByText("[mock] read first")).toBeVisible();

  await page.getByRole("button", { name: /Researched for/ }).click();
  await expect(page.getByRole("list", { name: "Research steps" })).toContainText("Searched the literature for");

  // Follow-up message (plain chat over the workspace is the default for follow-ups).
  await page.getByLabel("Follow-up message").fill("Which of these should I read first?");
  await page.getByLabel("Follow-up message").press("Enter");
  await expect(page.getByText("Which of these should I read first?")).toBeVisible();
  await expect(page.getByText(/\[mock\] Research report based on/)).toHaveCount(2, { timeout: 60_000 });

  await page.getByRole("button", { name: "Save as note" }).first().click();
  await page.getByRole("button", { name: "Open note" }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Note title")).toHaveValue(/^Research: What is known about attention/);
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();

  await page.goto("/research");
  await expect(page.getByRole("link", { name: "What is known about attention in transformers?" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the model picker switches the AI used while working, and Default follows Settings", async ({ page, context }) => {
  const errors = trackErrors(page);
  await signUp(context.request, "Picker");
  await page.goto("/settings?tab=ai");
  // Two connected providers: Ollama (not running here) and the mock, which becomes the default.
  await page.getByLabel("Provider").selectOption("ollama");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Ollama/)).toBeVisible();
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Mock/)).toBeVisible();

  await page.goto("/research");
  const picker = page.getByRole("button", { name: /^AI model:/ });
  await expect(picker).toHaveAccessibleName("AI model: Mock · mock-1 (default)");
  await picker.click();
  await page.getByRole("group", { name: "Ollama (local)" }).getByRole("menuitem", { name: "llama3.1" }).click();
  await expect(picker).toHaveAccessibleName("AI model: Ollama · llama3.1");

  // The picked model is used: Ollama is not running, so the research fails with an explanation.
  await page.getByLabel("Message", { exact: true }).fill("What is attention in transformers?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Could not reach Ollama|private network/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /^Failed after/ })).toBeVisible();

  // Back to the default (the mock), which also applies on this page.
  await page.getByRole("button", { name: /^AI model:/ }).click();
  await page.getByRole("menuitem", { name: /Default from Settings/ }).click();
  await expect(page.getByRole("button", { name: /^AI model:/ })).toHaveAccessibleName(/\(default\)$/);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/\[mock\] Research report based on/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/AI-generated · Mock · mock-1/).last()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the assistant proposes workspace changes; apply with a rename, undo, and auto-apply", async ({
  page,
  context,
}) => {
  const errors = trackErrors(page);
  await signUp(context.request, "Organizer");
  await page.goto("/settings?tab=ai");
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Mock/)).toBeVisible();

  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "Assistant" })).toBeVisible();
  // Plain chat over the workspace (no external services): the assistant proposes a collection and a concept.
  await page.getByLabel("Message", { exact: true }).fill("Organize my reading into a collection about attention");
  await expect(page.getByRole("button", { name: "Literature search" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/research\/[0-9a-f-]{36}$/);

  const changes = page.getByRole("region", { name: "Workspace changes" });
  await expect(changes.getByRole("heading", { name: "Proposed changes" })).toBeVisible({ timeout: 60_000 });
  await expect(changes.getByText("Nothing changes until you apply")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Attention papers")).toBeHidden();
  await changes.getByLabel(/^Name for: Create collection/).fill("Attention papers");
  await changes.getByRole("button", { name: "Apply all 2" }).click();
  await expect(changes.getByRole("heading", { name: "Applied changes" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Attention papers")).toBeVisible();
  await changes.getByRole("link", { name: "Open concept" }).click();
  await expect(page.getByRole("heading", { name: "Mock concept" })).toBeVisible();
  await page.goBack();

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("region", { name: "Workspace changes" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { name: "Changes undone" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Attention papers")).toBeHidden();

  // With auto-apply on, changes are made right away (and can still be undone).
  await page.getByRole("button", { name: "Auto-apply" }).click();
  await page.getByLabel("Follow-up message").fill("Now organize it into a collection again");
  await page.getByLabel("Follow-up message").press("Enter");
  await expect(page.getByRole("heading", { name: "Applied automatically" })).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("region", { name: "Workspace changes" }).last().getByRole("button", { name: "Undo" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
