import React from "react";
import { createRoot } from "react-dom/client";
import { configureTenant, environmentId } from "./api.ts";
import { Environments } from "./environments.tsx";
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
  const response = await fetch("/v1/me");
  if (!response.ok) throw new Error("请先通过 Cloudflare Access 登录");
  const me = (await response.json()) as { tenantId: string };
  configureTenant(me.tenantId);
  createRoot(document.getElementById("root")!).render(<Environments />);
}
void boot().catch((error) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent = error instanceof Error ? error.message : "页面加载失败";
});
