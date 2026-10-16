import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "./runtime/primitives.ts";
import {
  api,
  getSelection,
  post,
  select,
  subscribeSelection,
  tenantPath,
} from "./api.ts";
import { refreshState } from "./state.ts";
import type { Run, EventRecord, Content } from "./ui-types.ts";
import type {
  AgentRevision,
  TenantState,
} from "../../../packages/control-plane/src/contracts.ts";
import { createParser } from "eventsource-parser";
import {
  composerCss,
  heroCss,
  messageCss,
  DisclosureRow,
} from "./upstream-ui.ts";
import { MarkdownText } from "@weft/upstream/packages/client/ui-primitives/src/markdown/MarkdownText.tsx";
const markdownLabels = {
  code: { copyLabel: "复制", copiedLabel: "已复制" },
  footnotes: "脚注",
};
export function Chat({
  data,
  busy,
  onBusy,
  run,
  newSession,
}: {
  data: TenantState;
  busy: boolean;
  onBusy: (value: boolean) => void;
  run: Run;
  newSession: (agent?: AgentRevision) => void;
}): ReactNode {
  const selection = useSyncExternalStore(subscribeSelection, getSelection);
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [streaming, setStreaming] = useState("");
  const [optimistic, setOptimistic] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<{ id: string; sessionId: string }>();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setEvents([]);
    setStreaming("");
    setOptimistic("");
    if (
      !selection.sessionId ||
      !data.sessions.some((item) => item.id === selection.sessionId)
    )
      return;
    setLoading(true);
    void api<{ events: EventRecord[] }>(
      `sessions/${selection.sessionId}/events`,
    )
      .then((value) => {
        if (live) setEvents(value.events);
      })
      .catch((error) => {
        if (live)
          void run(async () => {
            throw error;
          });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selection.sessionId]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length, streaming]);
  async function send(text: string): Promise<void> {
    if (!text.trim() || busy) return;
    const current = getSelection();
    const sessionId = current.sessionId || crypto.randomUUID();
    if (!current.sessionId) select({ ...current, sessionId });
    const requestId = crypto.randomUUID();
    active.current = { id: requestId, sessionId };
    onBusy(true);
    setInput("");
    setOptimistic(text);
    setStreaming("");
    try {
      const response = await fetch(
        tenantPath(`sessions/${sessionId}/messages`),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            text,
            requestId,
            agent: { id: current.agentId, revision: current.revision },
          }),
        },
      );
      if (!response.ok)
        throw new Error(((await response.json()) as { error: string }).error);
      if (
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      )
        throw new Error("会话连接已过期，请刷新页面");
      let turnError: string | undefined;
      const parser = createParser({
        onEvent: (event) => {
          const value = JSON.parse(event.data) as EventRecord & {
            type: string;
            chunk?: { type: string; text?: string };
            message?: string;
          };
          if (event.event === "session-event") {
            setEvents((previous) =>
              previous.some((item) => item.seq === value.seq)
                ? previous
                : [...previous, value],
            );
            if (value.type === "user/message") setOptimistic("");
            if (value.type === "assistant/message") setStreaming("");
          }
          if (event.event === "assistant-stream") {
            if (value.type === "start") setStreaming("");
            if (value.type === "chunk" && value.chunk?.type === "text-delta")
              setStreaming((text) => text + value.chunk!.text);
          }
          if (event.event === "error")
            turnError = value.message ?? "Agent 运行失败";
        },
      });
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          parser.feed(result.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (turnError) throw new Error(turnError);
    } finally {
      active.current = undefined;
      onBusy(false);
      setStreaming("");
      setOptimistic("");
      const saved = await api<{ events: EventRecord[] }>(
        `sessions/${sessionId}/events`,
      ).catch(() => undefined);
      if (saved) setEvents(saved.events);
      await refreshState();
    }
  }
  const visible = events.filter((event) =>
    [
      "user/message",
      "assistant/message",
      "tool/call",
      "tool/result",
      "todo/write",
    ].includes(event.type),
  );
  return (
    <div
      className="chat-page"
      data-empty={(!visible.length && !busy && !loading) || undefined}
    >
      <div className="chat-heading">
        <select
          aria-label="选择 Agent"
          disabled={busy}
          value={selection.agentId}
          onChange={(event) => {
            newSession(
              data.agents.find((item) => item.spec.id === event.target.value),
            );
          }}
        >
          {data.agents.map((agent) => (
            <option value={agent.spec.id} key={agent.spec.id}>
              {agent.spec.name}
            </option>
          ))}
        </select>
        <span className="muted">
          v{selection.revision} <span className="dot">·</span>{" "}
          {selection.workspaceId}
        </span>
      </div>
      <div className="transcript" aria-live="polite">
        {!visible.length && !busy && !loading && (
          <div className={`welcome ${heroCss.stack}`}>
            <div className={heroCss.headline}>
              <span className="welcome-mark">w</span>
              <h1>探索未至之境</h1>
              <span className={heroCss.previewBadge}>预览版</span>
            </div>
          </div>
        )}
        {loading && <p className="muted">正在恢复会话…</p>}
        {visible.map((event) => (
          <EventView key={event.seq} event={event} />
        ))}
        {optimistic && (
          <div className="message user">
            <p>{optimistic}</p>
          </div>
        )}
        {streaming && (
          <div className="message assistant">
            <span className="role-label">DeepSeek</span>
            <MarkdownText text={streaming} streaming labels={markdownLabels} />
          </div>
        )}
        {busy && !streaming && (
          <div className="working">
            Agent 正在工作<span>•••</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className={`composer ${composerCss.card}`}
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => send(input));
        }}
      >
        <textarea
          aria-label="发送消息"
          placeholder="描述你的任务，或让 Agent 创建一个 UI 插件…"
          value={input}
          maxLength={8000}
          disabled={loading}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy) void run(() => send(input));
            }
          }}
        />
        <div className="composer-footer">
          <span>
            ◈ {selection.workspaceId} <span className="dot">·</span> DeepSeek
            Harness
          </span>
          {busy ? (
            <Button
              variant="outline"
              onClick={() => {
                const current = active.current;
                if (current)
                  void run(async () => {
                    await post(`sessions/${current.sessionId}/cancel`, {
                      requestId: current.id,
                    });
                  });
              }}
            >
              停止
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              aria-label="发送"
              disabled={!input.trim()}
            >
              ↑
            </Button>
          )}
        </div>
      </form>
      <div className="composer-note">
        文件与插件变更会保存在你的个人空间。生成的 UI 插件需在插件页启用。
      </div>
    </div>
  );
}

function EventView({ event }: { event: EventRecord }): ReactNode {
  const [open, setOpen] = useState(false);
  const message = (
    event.type === "user/message" ? event.data : event.data.message
  ) as { content?: Content[]; source?: { kind?: string } } | undefined;
  if (
    event.type === "user/message" &&
    message?.source?.kind &&
    message.source.kind !== "user"
  )
    return null;
  if (event.type === "user/message" || event.type === "assistant/message")
    return (
      <div
        className={`message ${event.type === "user/message" ? "user" : "assistant"}`}
      >
        <span className="role-label">
          {event.type === "user/message" ? "你" : "DeepSeek"}
        </span>
        {message?.content?.map((part, index) =>
          part.type === "text" ? (
            event.type === "user/message" ? (
              <p className={messageCss.bubble} key={index}>
                {part.text}
              </p>
            ) : (
              <MarkdownText
                key={index}
                text={part.text ?? ""}
                labels={markdownLabels}
              />
            )
          ) : part.type === "tool-call" ? null : (
            <details key={index}>
              <summary>{part.type}</summary>
              <pre>{JSON.stringify(part, null, 2)}</pre>
            </details>
          ),
        )}
      </div>
    );
  if (event.type === "todo/write")
    return (
      <div className="todo-card">
        <strong>任务进度</strong>
        {(
          (event.data.todos ?? event.data.items ?? []) as {
            content: string;
            status: string;
          }[]
        ).map((item) => (
          <p key={item.content}>
            {item.status === "completed"
              ? "✓"
              : item.status === "in_progress"
                ? "◉"
                : "○"}{" "}
            {item.content}
          </p>
        ))}
      </div>
    );
  return (
    <DisclosureRow
      icon={<span>⌁</span>}
      title={`${event.type === "tool/call" ? "调用工具" : "工具结果"} ${String(event.data.name ?? "")}`}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setOpen((value) => !value)}
    >
      <pre>{JSON.stringify(event.data, null, 2)}</pre>
    </DisclosureRow>
  );
}
