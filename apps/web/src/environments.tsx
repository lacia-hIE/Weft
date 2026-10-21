import React, { useEffect, useState, type ReactNode } from "react";
import { api, post } from "./api.ts";
import { BrandWordmark, Button, FishLogo, Input } from "./runtime/primitives.ts";
import type { EnvironmentRecord } from "../../../packages/control-plane/src/contracts.ts";
import "./environments.css";

/**
 * The site home page sits outside every environment, so it has no theme
 * setting of its own: it follows the system scheme with the official palette
 * selector, as a workbench on the `system` preference does.
 */
function useSystemTheme(): void {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.body.toggleAttribute("data-ds-dark-theme", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}

const updated = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });

export function Environments(): ReactNode {
  useSystemTheme();
  const [environments, setEnvironments] = useState<EnvironmentRecord[] | undefined>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () =>
    setEnvironments(
      (await api<{ environments: EnvironmentRecord[] }>("environments"))
        .environments,
    );
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
  }, []);
  async function create(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await post("environments", { name });
      setName("");
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="home">
      <header className="home-bar">
        <BrandWordmark size={24} className="home-brand" />
        <a className="home-logout" href="/cdn-cgi/access/logout">退出登录</a>
      </header>
      <main className="home-main">
        <section className="home-intro">
          <h1>我的 Agents</h1>
          <p>每个 Agent 是一套独立的 Harness 环境，拥有自己的预设、插件、会话与工作区。</p>
        </section>
        <form
          className="home-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            aria-label="Agent 名称"
            placeholder="为新的 Agent 命名"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
          />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            创建 Agent
          </Button>
        </form>
        {error && <p className="home-error" role="alert">{error}</p>}
        <section className="home-grid" aria-label="Agent 列表" aria-busy={environments === undefined}>
          {environments === undefined
            ? [0, 1].map((index) => <div key={index} className="home-card home-card-loading" aria-hidden />)
            : environments.map((environment) => (
              <a
                key={environment.id}
                className="home-card"
                aria-label={`进入 ${environment.name}`}
                href={`/agents/${environment.id}`}
              >
                <span className="home-card-mark" aria-hidden><FishLogo size={18} /></span>
                <span className="home-card-body">
                  <span className="home-card-title">
                    <strong>{environment.name}</strong>
                    {environment.id === "default" && <span className="home-badge">默认</span>}
                  </span>
                  <span className="home-card-meta">
                    <code>{environment.id}</code>
                    <span>更新于 {updated.format(new Date(environment.updatedAt))}</span>
                  </span>
                </span>
                <span className="home-card-open" aria-hidden>进入工作台 →</span>
              </a>
            ))}
        </section>
      </main>
    </div>
  );
}
