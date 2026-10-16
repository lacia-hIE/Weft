import React, { useState, type ReactNode } from "react";
import { Button, Input, Switch, Tag } from "./runtime/primitives.ts";
import { post } from "./api.ts";
import { refreshState, pluginErrors } from "./state.ts";
import type { Run } from "./ui-types.ts";
import type {
  ClientPlugin,
  TenantState,
} from "../../../packages/control-plane/src/contracts.ts";
import { pluginsCss } from "./upstream-ui.ts";
const example = `import React from 'react';\nexport const inject = ['slots'];\nexport function apply(ctx) {\n  ctx.slots.inject('weft.panel', () => ctx.slots.register({ name: 'weft.panel', id: 'counter' }, function Counter() {\n    const [count, setCount] = React.useState(0);\n    return <section><h3>计数器</h3><p>{count}</p><button onClick={() => setCount(count + 1)}>加一</button></section>;\n  }));\n}\n`;
export function Plugins({
  data,
  run,
}: {
  data: TenantState;
  run: Run;
}): ReactNode {
  const [editor, setEditor] = useState<{
    id: string;
    name: string;
    source: string;
    config: Record<string, unknown>;
  }>();
  const [saving, setSaving] = useState(false);
  const [configText, setConfigText] = useState("{}");
  function edit(value: NonNullable<typeof editor>) {
    setEditor({
      id: value.id,
      name: value.name,
      source: value.source,
      config: value.config,
    });
    setConfigText(JSON.stringify(value.config, null, 2));
  }
  async function enable(plugin: ClientPlugin, enabled: boolean): Promise<void> {
    await post(`client-plugins/${plugin.id}/enable`, {
      revision: plugin.revision,
      enabled,
    });
    await refreshState();
  }
  return (
    <div className={`page ${pluginsCss.page}`}>
      <div className={`page-title ${pluginsCss.pageHead}`}>
        <div>
          <h1>UI 插件</h1>
          <p>让 Agent 编写 Cordis 插件，或直接编辑一个。</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            edit({
              id: `plugin-${crypto.randomUUID().slice(0, 8)}`,
              name: "计数器",
              source: example,
              config: {},
            });
          }}
        >
          ＋ 创建 UI 插件
        </Button>
      </div>
      <div className="notice">
        客户端插件可访问当前页面和你的会话、工作区。请审核源码后启用；每次发布新源码都会重新停用。
      </div>
      {!data.clientPlugins.length && !editor && (
        <div className="empty-card">
          <span>▦</span>
          <h2>从一个小工具开始</h2>
          <p>在 Agent 设置中允许创建 UI 插件，然后在会话里描述你需要的界面。</p>
          <Button
            variant="outline"
            onClick={() => {
              edit({
                id: "counter",
                name: "计数器",
                source: example,
                config: {},
              });
            }}
          >
            试试计数器示例
          </Button>
        </div>
      )}
      {data.clientPlugins.map((plugin) => (
        <div className="settings-card" key={plugin.id}>
          <div className="setting-row">
            <div>
              <h3>
                {plugin.name} <Tag>{plugin.enabled ? "已启用" : "待审核"}</Tag>
              </h3>
              <p>
                {new Date(plugin.publishedAt).toLocaleString()} ·{" "}
                {plugin.revision.slice(0, 8)}
              </p>
            </div>
            <Switch
              label={`启用 ${plugin.name}`}
              checked={plugin.enabled}
              onChange={(enabled) => {
                void run(() => enable(plugin, enabled));
              }}
            />
          </div>
          {pluginErrors[plugin.id] && (
            <p role="alert" className="error-text">
              {pluginErrors[plugin.id]}
            </p>
          )}
          <details>
            <summary>查看源码</summary>
            <pre>{plugin.source}</pre>
          </details>
          <Button
            variant="outline"
            onClick={() => {
              edit(plugin);
            }}
          >
            编辑并发布
          </Button>
        </div>
      ))}
      {editor && (
        <div className="settings-card editor">
          <div className="setting-row">
            <h2>插件源码</h2>
            <Button
              onClick={() => {
                setEditor(undefined);
              }}
            >
              关闭
            </Button>
          </div>
          <div className="field-grid">
            <label>
              名称
              <Input
                aria-label="插件名称"
                value={editor.name}
                onChange={(event) => {
                  setEditor({ ...editor, name: event.target.value });
                }}
              />
            </label>
            <label>
              插件 ID
              <Input
                aria-label="插件 ID"
                value={editor.id}
                onChange={(event) => {
                  setEditor({ ...editor, id: event.target.value });
                }}
              />
            </label>
          </div>
          <textarea
            aria-label="插件源码"
            spellCheck={false}
            className="code-editor"
            value={editor.source}
            onChange={(event) => {
              setEditor({ ...editor, source: event.target.value });
            }}
          />
          <label className="field">
            配置（JSON）
            <textarea
              aria-label="插件配置"
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              void run(async () => {
                setSaving(true);
                try {
                  await post("client-plugins", {
                    ...editor,
                    config: JSON.parse(configText),
                  });
                  await refreshState();
                  setEditor(undefined);
                } finally {
                  setSaving(false);
                }
              });
            }}
          >
            编译并发布
          </Button>
        </div>
      )}
    </div>
  );
}
