import { test, expect } from "@playwright/test";

test("Agent catalogue opens the official Harness by default and keeps environment sessions isolated", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", {name: "我的 Agents"})).toBeVisible();
  await page.getByRole("textbox", {name: "Agent 名称"}).fill("Research environment");
  await page.getByRole("button", {name: "创建 Agent", exact: true}).click();
  await page.getByRole("link", {name: "进入 Research environment", exact: true}).click();
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await page.locator('[contenteditable=true]').fill('Research environment only');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText(/^Tenant: /).last()).toBeVisible({timeout: 30_000});
  await page.getByRole('link', {name: 'My Agents', exact: true}).click();
  await page.getByRole("link", {name: "进入 我的 Harness", exact: true}).click();
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await expect(page.getByText('Research environment only', {exact: true})).toHaveCount(0);
  await page.getByRole('link', {name: 'My Agents', exact: true}).click();
  await page.getByRole('link', {name: '进入 Research environment', exact: true}).click();
  await expect(page.getByText('Research environment only', {exact: true}).last()).toBeVisible({timeout: 45_000});
  expect(errors).toEqual([]);
});

