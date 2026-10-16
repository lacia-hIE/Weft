import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "./runtime/primitives.ts";
import {
  configureTenant,
  getSelection,
  select,
  subscribeSelection,
} from "./api.ts";
import { refreshState, host, getState, subscribe, safeMode } from "./state.ts";
import type { AgentRevision } from "../../../packages/control-plane/src/contracts.ts";
import type { PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import { Chat } from "./chat.tsx";
import { Agents } from "./agents.tsx";
import { Plugins } from "./plugins.tsx";
import { Files } from "./files.tsx";
import { useLayout } from "./layout.ts";
import {
  sidebarCss,
  IconPanelLeftOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineRegular,
  IconSettingsOutlineRegular,
} from "./upstream-ui.ts";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/focus.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/scrollbar.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/gradient-shadow-text.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/shiki.css";
import "../../../deepseek-harness/packages/client/ui-theme/src/styles/corner-shape.css";
import "@deepseek-ai/dsh-client-ui-dockkit"; // Include SDK surfaces in the page stylesheet.
import "./style.css";
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "weft.panel": {
      kind: "list";
      scope: "root";
      owner: { host: ReturnType<typeof getSelection> };
    };
    "weft.toolbar": {
      kind: "list";
      scope: "root";
      owner: { host: ReturnType<typeof getSelection> };
    };
    "shell.overlay": {
      kind: "list";
      scope: "root";
      owner: { host: ReturnType<typeof getSelection> };
    };
  }
}
type ShellProps = PropsRenderSlots<
  "weft.panel" | "weft.toolbar" | "shell.overlay"
>;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "操作失败";

function App({ renderSlot }: ShellProps): ReactNode {
  const data = useSyncExternalStore(subscribe, getState);
  const selection = useSyncExternalStore(subscribeSelection, getSelection);
  const [page, setPage] = useState<"chat" | "agents" | "plugins" | "files">(
    "chat",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [dark, setDark] = useState(
    document.body.hasAttribute("data-ds-dark-theme"),
  );
  const layout = useLayout(
    data.clientPlugins.filter((plugin) => plugin.enabled).length,
  );
  useEffect(() => {
    void fetch("/v1/me")
      .then((r) => r.json())
      .then((value) => {
        setEmail((value as { user: { email: string } }).user.email);
      });
  }, []);
  async function run(action: () => Promise<void>): Promise<void> {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  function newSession(agent?: AgentRevision): void {
    const profile =
      agent ??
      data.agents.find((item) => item.spec.id === selection.agentId) ??
      data.agents[0];
    if (!profile) return;
    select({
      sessionId: crypto.randomUUID(),
      agentId: profile.spec.id,
      workspaceId: profile.spec.workspaceId,
      revision: profile.revision,
    });
    setPage("chat");
  }
  return (
    <div
      className="app"
      style={layout.style as React.CSSProperties}
      data-sidebar-collapsed={layout.collapsed || undefined}
    >
      <aside
        className={`sidebar ${sidebarCss.root} ${layout.collapsed ? sidebarCss.collapsed : ""}`}
      >
        <div className="logo-row">
          <a href="/" className="brand">
            <span className="brand-icon">w</span>
            <strong>weft</strong>
            <span className="alpha">预览版</span>
          </a>
          <button
            className="icon-button sidebar-toggle"
            aria-label={layout.collapsed ? "展开侧栏" : "收起侧栏"}
            onClick={layout.toggleSidebar}
          >
            <IconPanelLeftOutlineRegular size={18} />
          </button>
        </div>
        <Button
          className={`new-chat ${sidebarCss.newSession}`}
          aria-label="新建会话"
          variant="outline"
          disabled={busy}
          onClick={() => {
            newSession();
          }}
        >
          <IconNewChatOutlineRegular size={16} />
          <span>新建会话</span>
        </Button>
        <nav aria-label="主导航">
          {(
            [
              ["chat", IconNewChatOutlineRegular, "会话"],
              ["agents", IconSettingsOutlineRegular, "Agent 预设"],
              ["plugins", IconPluginPinwheelOutlineRegular, "UI 插件"],
              ["files", IconFolderOpenRegular, "工作区"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              aria-label={label}
              aria-current={page === key ? "page" : undefined}
              onClick={() => {
                setPage(key);
              }}
            >
              <Icon size={18} />
              <span className="nav-label">{label}</span>
              {key === "plugins" && data.clientPlugins.length > 0 ? (
                <small>{data.clientPlugins.length}</small>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="section-label">最近会话</div>
        <div className="sessions">
          {!data.sessions.length && (
            <p className="muted">你的会话会保存在这里</p>
          )}
          {data.sessions.map((session) => (
            <button
              disabled={busy}
              key={session.id}
              className={selection.sessionId === session.id ? "selected" : ""}
              onClick={() => {
                select({
                  sessionId: session.id,
                  agentId: session.agentId,
                  revision: session.revision,
                  workspaceId: session.workspaceId,
                });
                setPage("chat");
              }}
            >
              <span>{session.title}</span>
              <small>
                {session.agentId} · v{session.revision}
              </small>
            </button>
          ))}
        </div>
        <div className="account">
          <span className="avatar">
            {email.slice(0, 1).toUpperCase() || "W"}
          </span>
          <div>
            <strong>{email || "Cloudflare Access"}</strong>
            <small>个人空间</small>
          </div>
          <a aria-label="退出登录" href="/cdn-cgi/access/logout">
            ↗
          </a>
        </div>
      </aside>
      <main>
        {safeMode && (
          <div className="notice">
            安全模式：已暂停加载 UI 插件。可以在插件页停用有问题的插件。
            <a href="/">退出安全模式</a>
          </div>
        )}
        <header>
          <div>
            <span className="breadcrumb">{selection.workspaceId} / </span>
            {
              {
                chat: "会话",
                agents: "Agent 预设",
                plugins: "UI 插件",
                files: "工作区",
              }[page]
            }
          </div>
          <div className="toolbar">
            <button
              className="icon-button"
              aria-label="切换深色模式"
              aria-pressed={dark}
              onClick={() => {
                const value = !dark;
                setDark(value);
                document.body.toggleAttribute("data-ds-dark-theme", value);
                localStorage.setItem("weft-theme", value ? "dark" : "light");
              }}
            >
              ◐
            </button>
            <span className="connection">
              <i /> 已连接
            </span>
            {renderSlot("weft.toolbar", { host: selection })}
            <button
              className="icon-button"
              aria-label="切换扩展面板"
              aria-expanded={layout.rightOpen}
              onClick={layout.toggleRight}
            >
              <IconPanelLeftOutlineRegular size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button
              aria-label="关闭错误"
              onClick={() => {
                setError("");
              }}
            >
              ×
            </button>
          </div>
        )}
        {page === "chat" && (
          <Chat
            data={data}
            busy={busy}
            onBusy={setBusy}
            run={run}
            newSession={newSession}
          />
        )}
        {page === "agents" && (
          <Agents data={data} run={run} newSession={newSession} />
        )}
        {page === "plugins" && <Plugins data={data} run={run} />}
        {page === "files" && <Files run={run} />}
      </main>
      <aside
        className={`extensions ${layout.overlay ? "panel-overlay" : ""}`}
        aria-label="插件面板"
        hidden={!layout.rightOpen}
      >
        <div className="section-label">
          扩展面板{" "}
          <button
            className="icon-button"
            aria-label="关闭扩展面板"
            onClick={layout.toggleRight}
          >
            ×
          </button>
        </div>
        {renderSlot("weft.panel", { host: selection })}
        <p
          className="extension-hint"
          hidden={
            !!data.clientPlugins.filter((plugin) => plugin.enabled).length
          }
        >
          启用的 UI 插件可以在这里显示工具与视图。
        </p>
      </aside>
      {!layout.collapsed && (
        <div
          className="resize-handle left"
          role="separator"
          aria-label="调整侧栏宽度"
          style={{ left: layout.columns.sidebar }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              layout.resizeSidebar(event.clientX);
          }}
        />
      )}
      {layout.columns.rightbar > 0 && (
        <div
          className="resize-handle right"
          role="separator"
          aria-label="调整扩展面板宽度"
          style={{ right: layout.columns.rightbar }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              layout.resizeRight(window.innerWidth - event.clientX);
          }}
        />
      )}
      <div className="overlay">
        {renderSlot("shell.overlay", { host: selection })}
      </div>
    </div>
  );
}

async function boot(): Promise<void> {
  const preference = localStorage.getItem("weft-theme");
  document.body.toggleAttribute(
    "data-ds-dark-theme",
    preference === "dark" ||
      (preference === null &&
        matchMedia("(prefers-color-scheme: dark)").matches),
  );
  const meResponse = await fetch("/v1/me");
  if (!meResponse.ok) throw new Error("请先通过 Cloudflare Access 登录");
  const me = (await meResponse.json()) as { tenantId: string };
  configureTenant(me.tenantId);
  await host.initialize();
  // Root and declared extension seats are owned by the shell; native renderer
  // enforces declaration ownership and contains rendering errors per entry.
  await host.ctx.plugin({
    name: "weft-shell",
    inject: ["slots"],
    apply(ctx) {
      ctx.slots.register(
        {
          name: "root",
          children: {
            "weft.panel": { kind: "list", scope: "root" },
            "weft.toolbar": { kind: "list", scope: "root" },
            "shell.overlay": { kind: "list", scope: "root" },
          },
        },
        App,
      );
    },
  });
  await refreshState(false);
  const initial = getState().agents[0];
  if (initial)
    select({
      sessionId: "",
      agentId: initial.spec.id,
      revision: initial.revision,
      workspaceId: initial.spec.workspaceId,
    });
  host.ctx.uiRenderer.mount(document.getElementById("root")!);
  void refreshState().catch((error) => {
    console.error("Plugin restoration failed", error);
  });
}
void boot().catch((error) => {
  const root = document.getElementById("root");
  if (root) {
    root.replaceChildren();
    const p = document.createElement("p");
    p.textContent = errorMessage(error);
    root.appendChild(p);
    const a = document.createElement("a");
    a.href = "/";
    a.textContent = "重新加载";
    root.appendChild(a);
  }
});
