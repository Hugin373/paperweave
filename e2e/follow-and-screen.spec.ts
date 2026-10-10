import { expect, test } from "@playwright/test";
import { BASE_URL, signUp, trackErrors } from "./helpers";

test("follow a topic, and screen a collection with the AI, overriding a decision", async ({ page, context }) => {
  const errors = trackErrors(page);
  await signUp(context.request, "Screener");
  await page.goto("/settings?tab=ai");
  await page.getByLabel("Provider").selectOption("mock");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Connected · Mock/)).toBeVisible();

  // Follow a topic: it is listed under New papers (runs daily; the first run happens in the background).
  await page.getByRole("link", { name: "New papers" }).click();
  await expect(page.getByRole("heading", { name: "New papers" })).toBeVisible();
  await page.getByLabel("Search to follow").fill("point cloud completion");
  await page.getByRole("button", { name: "Follow" }).click();
  await expect(page.getByText("point cloud completion", { exact: true })).toBeVisible();

  // A collection with one paper to screen.
  await page.goto("/search");
  await page.getByLabel("Search scholarly literature").fill("arXiv:1706.03762");
  await page.getByLabel("Search scholarly literature").press("Enter");
  await expect(page).toHaveURL(/\/papers\/[0-9a-f-]{36}/, { timeout: 45_000 });
  const paperId = /\/papers\/([0-9a-f-]{36})/.exec(page.url())![1];
  const collection = await (
    await page.request.post("/api/collections", { data: { name: "Review candidates" }, headers: { origin: BASE_URL } })
  ).json();
  const added = await page.request.post(`/api/collections/${collection.id}/papers`, {
    data: { paperIds: [paperId] },
    headers: { origin: BASE_URL },
  });
  expect(added.ok(), await added.text()).toBeTruthy();

  await page.getByRole("link", { name: "Screening" }).click();
  await page.getByRole("button", { name: "New screening" }).first().click();
  await page.getByLabel("Title").fill("Cardiac review");
  await page
    .getByLabel("Inclusion and exclusion criteria")
    .fill("Include: cardiac imaging studies. Exclude: everything else.");
  await page.getByLabel("Papers to screen").selectOption({ label: "Review candidates (1)" });
  await page.getByRole("button", { name: "Start screening" }).click();
  await expect(page).toHaveURL(/\/screening\/[0-9a-f-]{36}$/);

  // The mock AI excludes it (not cardiac) with a reason; the user overrides.
  await expect(page.getByText("1 of 1 screened")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Exclude · AI")).toBeVisible();
  await expect(page.getByText("[mock] Does not meet the criteria.")).toBeVisible();
  await page.getByRole("button", { name: "Include", exact: true }).click();
  await expect(page.getByText("Include · you")).toBeVisible();
  const csv = await page.request.get(`${page.url().replace(/\/screening\//, "/api/screenings/")}/export`);
  expect(await csv.text()).toContain('"include","user"');

  expect(errors).toEqual([]);
});
