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

test("native Cordis slots mount, interact, dispose and survive refresh; chat and files are usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/agents/default?ui=transition");
  await expect(
    page.getByRole("heading", { name: "探索未至之境" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "UI 插件", exact: true }).click();
  await page.getByRole("button", { name: "试试计数器示例" }).click();
  await page.getByRole("button", { name: "编译并发布" }).click();
  await expect(
    page.getByRole("switch", { name: "启用 计数器" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("button", { name: "加一", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("switch", { name: "启用 计数器" }).click();
  await page.getByRole("button", { name: "加一", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "插件面板" }),
  ).toContainText("1");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加一", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "UI 插件", exact: true }).click();
  await page.getByRole("switch", { name: "启用 计数器" }).click();
  await expect(
    page.getByRole("button", { name: "加一", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Agent 预设", exact: true }).click();
  await page.locator('.agent-tabs > button').filter({hasText: 'DeepSeek Assistant'}).click();
  await page.getByRole("switch", { name: "允许 Agent 创建 UI 插件" }).click();
  await page.getByRole("switch", { name: "启用时间上下文" }).click();
  await page.getByRole("button", { name: "发布新版本" }).click();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始会话", exact: true }).click();
  await page
    .getByRole("textbox", { name: "发送消息" })
    .fill("Use your identity tool");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".transcript")).toContainText("Tenant:", {
    timeout: 30_000,
  });
  await expect(page.locator(".transcript .message.user")).toContainText(
    "Use your identity tool",
  );
  await page.reload();
  await page
    .getByRole("button", {
      name: "Use your identity tool default · v2",
      exact: true,
    })
    .click();
  await expect(page.locator(".transcript .message.user")).toContainText(
    "Use your identity tool",
  );
  await expect(page.locator(".transcript")).toContainText("Tenant:");
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page
    .getByRole("textbox", { name: "新文件路径" })
    .fill("/workspace/browser.md");
  await page.getByRole("button", { name: "创建文件", exact: true }).click();
  await page
    .getByRole("textbox", { name: "文件内容" })
    .fill("Saved from the web UI");
  await page.getByRole("button", { name: "保存文件", exact: true }).click();
  await expect(page.getByText("版本 2")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: /browser.md/ }).click();
  await expect(page.getByRole("textbox", { name: "文件内容" })).toHaveValue(
    "Saved from the web UI",
  );
  await page.screenshot({ path: "dist/web-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "会话", exact: true })
    .click();
  const titleBox = await page
    .getByRole("heading", { name: "探索未至之境" })
    .boundingBox();
  const inputBox = await page
    .getByRole("textbox", { name: "发送消息" })
    .boundingBox();
  expect(
    titleBox && inputBox && titleBox.y + titleBox.height < inputBox.y,
  ).toBeTruthy();
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(
    page.getByRole("button", { name: "切换深色模式" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "dist/web-dark.png", fullPage: true });
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.screenshot({ path: "dist/web-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test("native store and Config work in browser plugins; invalid configurations and recovery remain usable", async ({
  page,
}) => {
  await page.goto("/agents/default?ui=transition");
  await page.getByRole("button", { name: "UI 插件", exact: true }).click();
  await page
    .getByRole("button", { name: "创建 UI 插件", exact: false })
    .click();
  await page.getByRole("textbox", { name: "插件名称" }).fill("Native store");
  await page.getByRole("textbox", { name: "插件 ID" }).fill("native-store");
  await page
    .getByRole("textbox", { name: "插件源码" })
    .fill(
      `import {useState} from 'react';import Schema from '@deepseek-ai/schemastery';import {defineStore} from '@deepseek-ai/dsh-client-store';import {Button,MarkdownText} from '@deepseek-ai/dsh-client-ui-primitives';import {createInitialState,createIdMinter} from '@deepseek-ai/dsh-client-ui-dockkit';export const inject={slots:null};export const Config=Schema.object({initial:Schema.number().required()});export function apply(ctx,config){const store=defineStore({init:()=>({count:config.initial}),actions:{increment(state){state.count++}}});ctx.slots.inject('weft.panel',()=>ctx.slots.register({name:'weft.panel',id:'native-store',store},({useStore,actions})=><section><h3>NATIVE_STORE</h3><MarkdownText text={"**Native Markdown**"} labels={{code:{copyLabel:"复制",copiedLabel:"已复制"},footnotes:"脚注"}}/><p>Dock panes: {Object.keys(createInitialState(createIdMinter()).nodes).length}</p><p>Stored: {useStore(s=>s.count)}</p><Button onClick={actions.increment}>Store increment</Button></section>))}`,
    );
  await page.getByRole("textbox", { name: "插件配置" }).fill('{"initial":3}');
  await page.getByRole("button", { name: "编译并发布" }).click();
  await page
    .getByRole("switch", { name: "启用 Native store", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "插件面板" }),
  ).toContainText("Stored: 3");
  await expect(
    page.getByRole("complementary", { name: "插件面板" }).locator("strong"),
  ).toHaveText("Native Markdown");
  await expect(
    page.getByRole("complementary", { name: "插件面板" }),
  ).toContainText("Dock panes: 1");
  await page
    .getByRole("button", { name: "Store increment", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "插件面板" }),
  ).toContainText("Stored: 4");
  await page
    .locator(".settings-card")
    .filter({
      has: page.getByRole("switch", { name: "启用 Native store", exact: true }),
    })
    .getByRole("button", { name: "编辑并发布" })
    .click();
  await page
    .getByRole("textbox", { name: "插件配置" })
    .fill('{"initial":"wrong"}');
  await page.getByRole("button", { name: "编译并发布" }).click();
  await expect(
    page.getByRole("button", { name: "Store increment", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("switch", { name: "启用 Native store", exact: true })
    .click();
  await expect(page.locator(".error-text")).toContainText("invalid config");
  await page.goto("/agents/default?ui=transition&safe=1");
  await expect(page.getByText("安全模式：", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "UI 插件", exact: true }).click();
  await page
    .getByRole("switch", { name: "启用 Native store", exact: true })
    .click();
  await page.goto("/agents/default?ui=transition");
  await expect(
    page.getByRole("heading", { name: "探索未至之境" }),
  ).toBeVisible();
});

test("real DeepSeek authors a UI plugin through native file tools and a user enables its Cordis contribution", async ({
  page,
}) => {
  test.skip(
    process.env.WEFT_BROWSER_LIVE !== "1",
    "Explicit live model verification only",
  );
  await page.goto("/");
  await page.getByRole("textbox", {name: "Agent 名称"}).fill("Live Harness environment");
  await page.getByRole("button", {name: "创建 Agent", exact: true}).click();
  await page.getByRole("link", {name: "进入 Live Harness environment", exact: true}).click();
  await page.goto(page.url()+'?ui=transition');
  await page.getByRole("button", { name: "Agent 预设", exact: true }).click();
  await page.locator('.agent-tabs > button').filter({hasText: 'DeepSeek Assistant'}).click();
  const permission = page.getByRole("switch", {
    name: "允许 Agent 创建 UI 插件",
  });
  if ((await permission.getAttribute("aria-checked")) !== "true") {
    await permission.click();
    await page.getByRole("button", { name: "发布新版本" }).click();
  }
  await page.getByRole("button", { name: "开始会话", exact: true }).click();
  await page
    .getByRole("textbox", { name: "发送消息" })
    .fill(
      "Create a browser UI Cordis plugin now. Write /workspace/live-panel.tsx and call ui_publish_plugin with id live-panel and name Live Panel. It must register weft.panel with a React component displaying the exact heading LIVE_HARNESS_PLUGIN and a button named Live increment. Start a counter at 0 and clicking the button increments it. Use import React from 'react', export const inject=['slots'], export function apply(ctx) {ctx.slots.inject('weft.panel',()=>ctx.slots.register({name:'weft.panel',id:'live-panel'},function Panel(){ const [n,setN]=React.useState(0); return <section><h3>LIVE_HARNESS_PLUGIN</h3><p>Live count: {n}</p><button onClick={()=>setN(n+1)}>Live increment</button></section>}))}. Do not use external imports. Actually write and publish, do not just explain.",
    );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0, { timeout: 175_000 });
  await page.getByRole("button", { name: "UI 插件", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "启用 Live Panel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("switch", { name: "启用 Live Panel", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "LIVE_HARNESS_PLUGIN" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Live increment", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "插件面板" }),
  ).toContainText("Live count: 1");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "LIVE_HARNESS_PLUGIN" }),
  ).toBeVisible();
  await page.screenshot({ path: "dist/web-live-plugin.png", fullPage: true });
});
