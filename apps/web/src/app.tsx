import React from "react";
import { createRoot } from "react-dom/client";
import { configureTenant, environmentId } from "./api.ts";
import "@weft/upstream/packages/client/ui-theme/src/styles/base.css";
import "@weft/upstream/packages/client/ui-theme/src/styles/design-platform.css";
import "@weft/upstream/packages/client/ui-theme/src/styles/focus.css";
import "@weft/upstream/packages/client/ui-theme/src/styles/scrollbar.css";

async function boot(): Promise<void> {
  if (environmentId) {
    const {startOfficialHarness} = await import('./official/entry.ts');
    await startOfficialHarness(environmentId);
    return;
  }
  const [response, {Environments}] = await Promise.all([fetch("/v1/me"), import('./environments.tsx')]);
  if (!response.ok) throw new Error("请先通过 Cloudflare Access 登录");
  const me = (await response.json()) as { tenantId: string; user: {id: string; email: string} };
  configureTenant(me.tenantId);
  createRoot(document.getElementById("root")!).render(<Environments user={me.user} />);
}
void boot().catch((error) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent = error instanceof Error ? error.message : "页面加载失败";
});
