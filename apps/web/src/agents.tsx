import React, { useEffect, useState, type ReactNode } from "react";
import { Button, Input, Switch } from "./runtime/primitives.ts";
import { api, post } from "./api.ts";
import { refreshState } from "./state.ts";
import type { Run, CatalogEntry } from "./ui-types.ts";
import type {
  AgentRevision,
  AgentSpec,
  TenantState,
} from "../../../packages/control-plane/src/contracts.ts";
import { pluginsCss } from "./upstream-ui.ts";
export function Agents({
  data,
  run,
  newSession,
}: {
  data: TenantState;
  run: Run;
  newSession: (agent?: AgentRevision) => void;
}): ReactNode {
  const [chosen, setChosen] = useState(data.agents[0]?.spec.id ?? "default");
  const current = data.agents.find((agent) => agent.spec.id === chosen);
  const [draft, setDraft] = useState<AgentSpec | undefined>(current?.spec);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [invalidFields, setInvalidFields] = useState(new Set<string>());
  useEffect(() => {
    void run(async () => {
      setCatalog((await api<{ plugins: CatalogEntry[] }>("plugins")).plugins);
    });
  }, []);
  useEffect(() => {
    if (current) {
      setDraft(current.spec);
      setInvalidFields(new Set());
    }
  }, [current]);
  if (!draft) return <p>正在读取 Agent…</p>;
  function change(patch: Partial<AgentSpec>): void {
    setDraft((value) => (value ? { ...value, ...patch } : value));
  }
  async function publish(): Promise<void> {
    setSaving(true);
    try {
      await post("agents", {
        spec: draft,
        expectedRevision: current?.revision ?? 0,
      });
      await refreshState();
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className={`page ${pluginsCss.page}`}>
      <div className={`page-title ${pluginsCss.pageHead}`}>
        <div>
          <h1>Agent 预设</h1>
          <p>装配原生插件，发布一个可以随时回到的版本。</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            const value = {
              ...draft,
              id: `agent-${crypto.randomUUID().slice(0, 8)}`,
              name: "新 Agent",
            };
            setChosen(value.id);
            setDraft(value);
          }}
        >
          ＋ 新建 Agent
        </Button>
      </div>
      <div className="agent-tabs">
        {data.agents.map((agent) => (
          <button
            key={agent.spec.id}
            className={chosen === agent.spec.id ? "active" : ""}
            onClick={() => {
              setChosen(agent.spec.id);
            }}
          >
            {agent.spec.name}
            <small>v{agent.revision}</small>
          </button>
        ))}
      </div>
      <div className="settings-card">
        <h2>基本设置</h2>
        <div className="field-grid">
          <label>
            名称
            <Input
              aria-label="Agent 名称"
              value={draft.name}
              onChange={(event) => {
                change({ name: event.target.value });
              }}
            />
          </label>
          <label>
            工作区
            <Input
              aria-label="工作区 ID"
              value={draft.workspaceId}
              onChange={(event) => {
                change({ workspaceId: event.target.value });
              }}
            />
          </label>
        </div>
        <label className="field">
          系统指令
          <textarea
            aria-label="系统指令"
            value={draft.persona}
            onChange={(event) => {
              change({ persona: event.target.value });
            }}
          />
        </label>
        <div className="setting-row">
          <div>
            <strong>允许 Agent 创建 UI 插件</strong>
            <p>启用源码编写与发布工具。发布后由你审核并启用插件。</p>
          </div>
          <Switch
            label="允许 Agent 创建 UI 插件"
            checked={draft.allowClientPlugins}
            onChange={(value) => {
              change({ allowClientPlugins: value });
            }}
          />
        </div>
      </div>
      <h2 className="section-title">
        原生 Harness 插件 <span>{draft.plugins.length} 个已选</span>
      </h2>
      {catalog.map((entry) => {
        const selected = draft.plugins.find((plugin) => plugin.id === entry.id);
        return (
          <div className="settings-card" key={entry.id}>
            <div className="setting-row">
              <div>
                <h3>{entry.title}</h3>
                <p>{entry.description}</p>
                <code>@deepseek-ai/dsh-{entry.id}</code>
              </div>
              <Switch
                label={`启用${entry.title}`}
                checked={!!selected}
                onChange={(enabled) => {
                  setInvalidFields(
                    (previous) =>
                      new Set(
                        [...previous].filter(
                          (field) => !field.startsWith(entry.id + ":"),
                        ),
                      ),
                  );
                  change({
                    plugins: enabled
                      ? [
                          ...draft.plugins,
                          { id: entry.id, config: entry.defaults },
                        ]
                      : draft.plugins.filter(
                          (plugin) => plugin.id !== entry.id,
                        ),
                  });
                }}
              />
            </div>
            {selected && (
              <div className="schema-fields">
                {entry.fields.map(({ name: key, type }) => (
                  <SchemaField
                    key={key}
                    name={key}
                    type={type}
                    onValidity={(valid) => {
                      setInvalidFields((previous) => {
                        const next = new Set(previous);
                        const field = `${entry.id}:${key}`;
                        if (valid) next.delete(field);
                        else next.add(field);
                        return next;
                      });
                    }}
                    value={selected.config[key]}
                    onChange={(value) => {
                      change({
                        plugins: draft.plugins.map((plugin) =>
                          plugin.id === entry.id
                            ? {
                                ...plugin,
                                config: { ...plugin.config, [key]: value },
                              }
                            : plugin,
                        ),
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="publish-bar">
        <p>
          已有会话固定使用创建时的版本。发布会生成 v
          {(current?.revision ?? 0) + 1}。
        </p>
        <Button
          variant="primary"
          disabled={saving || invalidFields.size > 0}
          onClick={() => {
            void run(publish);
          }}
        >
          {saving ? "发布中…" : "发布新版本"}
        </Button>
        <Button
          variant="outline"
          disabled={!current}
          onClick={() => {
            if (current) newSession(current);
          }}
        >
          开始会话
        </Button>
      </div>
    </div>
  );
}

function SchemaField({
  name,
  type,
  value,
  onChange,
  onValidity,
}: {
  name: string;
  type: string;
  value: unknown;
  onChange: (value: never) => void;
  onValidity: (valid: boolean) => void;
}): ReactNode {
  const [text, setText] = useState(JSON.stringify(value));
  if (type === "boolean")
    return (
      <div className="setting-row compact">
        <label>{name}</label>
        <Switch
          label={name}
          checked={!!value}
          onChange={(next) => {
            onChange(next as never);
          }}
        />
      </div>
    );
  if (type === "array" || type === "object")
    return (
      <label className="field">
        {name}
        <input
          aria-label={name}
          value={text ?? ""}
          onChange={(event) => {
            setText(event.target.value);
            try {
              onChange(JSON.parse(event.target.value) as never);
              event.target.setCustomValidity("");
              onValidity(true);
            } catch {
              event.target.setCustomValidity("请输入有效 JSON");
              onValidity(false);
            }
          }}
        />
      </label>
    );
  return (
    <label className="field">
      {name}
      <Input
        aria-label={name}
        type={type === "number" ? "number" : "text"}
        value={String(value ?? "")}
        onChange={(event) => {
          onChange(
            (type === "number"
              ? Number(event.target.value)
              : event.target.value) as never,
          );
        }}
      />
    </label>
  );
}
