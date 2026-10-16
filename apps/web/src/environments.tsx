import React, { useEffect, useState, type ReactNode } from "react";
import { api, post } from "./api.ts";
import { Button, Input } from "./runtime/primitives.ts";
import type { EnvironmentRecord } from "../../../packages/control-plane/src/contracts.ts";
import "./environments.css";

export function Environments(): ReactNode {
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
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
    <main className="environment-list">
      <header>
        <div>
          <p>weft</p>
          <h1>我的 Agents</h1>
          <p>每个 Agent 拥有独立的会话、文件和插件配置。</p>
        </div>
        <a href="/cdn-cgi/access/logout">退出登录</a>
      </header>
      <form
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
        <Button type="submit" disabled={busy || !name.trim()}>
          创建 Agent
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <section aria-label="Agent 列表">
        {environments.map((environment) => (
          <article key={environment.id}>
            <h2>{environment.name}</h2>
            <p>
              {environment.id === "default"
                ? "保留原有会话、工作区与插件"
                : "独立 Harness 环境"}
            </p>
            <a
              aria-label={`进入 ${environment.name}`}
              href={`/agents/${environment.id}`}
            >
              进入工作台 →
            </a>
          </article>
        ))}
      </section>
    </main>
  );
}
