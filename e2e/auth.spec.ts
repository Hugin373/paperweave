import { expect, test } from "@playwright/test";
import { PASSWORD, signIn, signUp, trackErrors, uniqueEmail } from "./helpers";

test("register, sign out, sign back in; private routes and APIs require a session", async ({ page, request }) => {
  const errors = trackErrors(page);
  const unauthorized = await request.get("/api/library");
  expect(unauthorized.status()).toBe(401);

  await page.goto("/library");
  await expect(page).toHaveURL(/\/login\?next=%2Flibrary/);

  await page.getByRole("link", { name: "Create an account" }).click();
  const email = uniqueEmail("register");
  await page.getByLabel("Name").fill("Rosalind");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/library/);
  await expect(page.getByText("Search for your first paper.")).toBeVisible();

  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();

  await page.getByRole("button", { name: "Rosalind" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();

  await signIn(page, email);
  expect(errors).toEqual([]);
});

test("the navigation sidebar can be hidden and stays hidden", async ({ page, request }) => {
  const errors = trackErrors(page);
  const { email } = await signUp(request, "Barbara");
  await signIn(page, email);
  const sidebar = page.getByRole("navigation", { name: "Main" });
  await expect(sidebar.getByRole("link", { name: "Library" })).toBeVisible();

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(sidebar).toBeHidden();

  await page.keyboard.press("Control+Backslash");
  await expect(sidebar.getByRole("link", { name: "Library" })).toBeVisible();
  expect(errors).toEqual([]);
});
