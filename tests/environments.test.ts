import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Response } from "miniflare";
import {
  createRuntime,
  tenantId,
  url,
  type User,
} from "./helpers/miniflare.ts";
import type {
  TenantState,
  ClientPlugin,
} from "../packages/control-plane/src/contracts.ts";

test("Harness environments isolate presets, modules, files and same-name sessions, persist, and adopt legacy data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weft-environments-"));
  let runtime = createRuntime(directory);
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    user: User = "alpha",
  ) =>
    runtime.dispatchFetch(url(user, `/v1/tenants/${tenantId(user)}${path}`), {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  const state = async (environment: string): Promise<TenantState> => {
    const response = await request(`/environments/${environment}/state`);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as TenantState;
  };
  try {
    assert.equal(
      (
        await request("/workspaces/default/files", "PUT", {
          path: "/workspace/legacy.txt",
          content: "kept",
          expectedVersion: null,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/environments/default/workspaces/default/files?path=/workspace/legacy.txt",
        )
      ).status,
      200,
    );
    for (const environment of ["coding", "research"])
      assert.equal(
        (
          await request("/environments", "POST", {
            id: environment,
            name: environment,
          })
        ).status,
        201,
      );
    assert.equal(
      (
        await request("/environments", "POST", {
          id: "coding",
          name: "duplicate",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/environments",
          "POST",
          { id: "coding", name: "beta" },
          "beta",
        )
      ).status,
      201,
    );
    assert.equal((await request("/environments/missing/state")).status, 404);
    assert.equal(
      (
        await runtime.dispatchFetch(
          url(
            "beta",
            `/v1/tenants/${tenantId("alpha")}/environments/coding/state`,
          ),
        )
      ).status,
      403,
    );
    const initial = (await state("coding")).agents[0]!;
    const published = await request("/environments/coding/agents", "POST", {
      spec: { ...initial.spec, name: "Coding preset" },
      expectedRevision: 1,
    });
    assert.equal(published.status, 200, await published.clone().text());
    assert.equal((await state("research")).agents[0]!.revision, 1);
    assert.equal((await state("default")).agents[0]!.revision, 1);
    const file = "/workspace/shared-name.txt";
    assert.equal(
      (
        await request("/environments/coding/workspaces/default/files", "PUT", {
          path: file,
          content: "coding only",
          expectedVersion: null,
        })
      ).status,
      200,
    );
    for (const environment of ["research", "default"])
      assert.equal(
        (
          await request(
            `/environments/${environment}/workspaces/default/files?path=${file}`,
          )
        ).status,
        404,
      );
    assert.equal(
      (
        await request(
          `/environments/coding/workspaces/default/files?path=${file}`,
          "GET",
          undefined,
          "beta",
        )
      ).status,
      404,
    );
    for (const environment of ["coding", "research"]) {
      const response = await request(
        `/environments/${environment}/sessions/same/messages`,
        "POST",
        {
          text: `${environment} private message`,
          agent: { id: "default", revision: environment === "coding" ? 2 : 1 },
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
    }
    const source = "export function apply(ctx) {}";
    const publication = await request(
      "/environments/coding/client-plugins",
      "POST",
      { id: "panel", name: "Coding panel", source },
    );
    assert.equal(publication.status, 200, await publication.clone().text());
    const plugin = (await publication.json()) as ClientPlugin;
    assert.equal(
      (
        await request(
          "/environments/coding/client-plugins/panel/enable",
          "POST",
          { revision: plugin.revision, enabled: true },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/environments/coding/client-plugins/${plugin.revision}/module.js`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/environments/research/client-plugins/${plugin.revision}/module.js`,
        )
      ).status,
      404,
    );
    assert.equal((await state("research")).clientPlugins.length, 0);
    const researchPublication = await request(
      "/environments/research/client-plugins",
      "POST",
      { id: "panel", name: "Research panel", source },
    );
    assert.equal(researchPublication.status, 200);
    assert.equal((await state("coding")).clientPlugins[0]!.name, "Coding panel");
    assert.equal((await state("research")).clientPlugins[0]!.name, "Research panel");
    assert.equal((await request("/environments/research/workspaces/default/files", "PUT", {
      path: file, content: "research only", expectedVersion: null,
    })).status, 200);
    const codingFile = await (await request(`/environments/coding/workspaces/default/files?path=${file}`)).json() as {value: {content: string}};
    assert.equal(codingFile.value.content, "coding only");
    await runtime.dispose();
    runtime = createRuntime(directory);
    for (const environment of ["coding", "research"]) {
      const response = await request(
        `/environments/${environment}/sessions/same/events`,
      );
      assert.equal(response.status, 200);
      const events = await response.text();
      assert.ok(events.includes(`${environment} private message`));
      assert.ok(
        !events.includes(
          `${environment === "coding" ? "research" : "coding"} private message`,
        ),
      );
      assert.equal((await state(environment)).sessions.length, 1);
    }
    assert.equal((await request("/sessions/same/events")).status, 404);
    assert.equal((await state("coding")).clientPlugins[0]!.enabled, true);
    assert.equal(
      (
        await request(
          "/environments/default/workspaces/default/files?path=/workspace/legacy.txt",
        )
      ).status,
      200,
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment model choices use the published session revision and server-owned credentials", async () => {
  const requestedModels: string[] = [];
  const runtime = createRuntime(undefined, {
    bindings: {
      MODEL_BACKEND: "deepseek",
      DEEPSEEK_API_KEY: "test-platform-key",
    },
    outbound: async (request) => {
      assert.equal(request.headers.get("x-api-key"), "test-platform-key");
      requestedModels.push(((await request.json()) as { model: string }).model);
      const event = (type: string, data = {}) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return new Response(
        event("message_start", {
          message: { usage: { input_tokens: 1, output_tokens: 0 } },
        }) +
          event("content_block_start", {
            index: 0,
            content_block: { type: "text", text: "done" },
          }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          }) +
          event("message_stop"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const base = `/v1/tenants/${tenantId("alpha")}`;
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
    for (const environment of ["coding", "research"]) {
      await request("/environments", { id: environment, name: environment });
      const state = (await (
        await request(`/environments/${environment}/state`)
      ).json()) as TenantState;
      assert.equal(
        (
          await request(`/environments/${environment}/agents`, {
            spec: {
              ...state.agents[0]!.spec,
              model: {
                provider: "deepseek",
                name:
                  environment === "coding" ? "deepseek-pro" : "deepseek-flash",
              },
            },
            expectedRevision: 1,
          })
        ).status,
        200,
      );
      const response = await request(
        `/environments/${environment}/sessions/same/messages`,
        { text: "hello", agent: { id: "default", revision: 2 } },
      );
      assert.equal(response.status, 200, await response.clone().text());
    }
    const coding = (await (
      await request("/environments/coding/state")
    ).json()) as TenantState;
    assert.equal(
      (
        await request("/environments/coding/agents", {
          spec: {
            ...coding.agents[0]!.spec,
            model: { provider: "deepseek", name: "deepseek-flash" },
          },
          expectedRevision: 2,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/environments/coding/sessions/same/messages", {
          text: "Continue with the original revision",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/environments/coding/sessions/new/messages", {
          text: "Use the new revision",
          agent: { id: "default", revision: 3 },
        })
      ).status,
      200,
    );
    assert.deepEqual(requestedModels, [
      "deepseek-pro",
      "deepseek-flash",
      "deepseek-pro",
      "deepseek-flash",
    ]);
  } finally {
    await runtime.dispose();
  }
});
