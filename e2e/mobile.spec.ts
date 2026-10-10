import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("the app is usable on a phone-sized screen", async ({ page, context }) => {
  await signUp(context.request, "Mobile");
  await page.goto("/library");
  await expect(page.getByText("Search for your first paper.")).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Notes" }).click();
  await expect(page).toHaveURL(/\/notes/);
  await expect(page.getByRole("heading", { name: "Write your first note" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
