import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Dynamic Worker loads native Cordis, scopes RPC capabilities, blocks egress and contains plugin failures", async () => {
  const options = convertV4MiniflareOptions({
    modules: true,
    scriptPath: resolve("dist/dynamic-worker.js"),
    compatibilityDate: "2026-07-30",
    workerLoaders: { LOADER: {} },
    bindings: { PLATFORM_SECRET: "must-not-cross-isolate" },
  });
  options.workers[0]!.dev = {
    ...options.workers[0]!.dev,
    unsafeRegisterWorker: false,
  };
  const runtime = new Miniflare(options);
  const run = (tenantId: string, source: string, revision = "1") =>
    runtime.dispatchFetch("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        tenantId,
        revision,
        source,
        config: { label: "Native Cordis" },
        input: { question: "test" },
      }),
    });
  const source = `export const inject=['host']; export function apply(ctx,config){ ctx.reflect.provide('pluginApi',{async run(input){let blocked=false;try{await fetch('https://example.com')}catch{blocked=true} const data=await ctx.host.read();return {data,blocked,label:config.label,input,secret:typeof globalThis.PLATFORM_SECRET}}}) }`;
  try {
    for (const tenant of ["alpha", "beta", "alpha"]) {
      const response = await run(tenant, source);
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as {
        data: { tenantId: string };
        blocked: boolean;
        secret: string;
        label: string;
      };
      assert.equal(result.data.tenantId, tenant);
      assert.equal(result.blocked, true);
      assert.equal(result.secret, "undefined");
      assert.equal(result.label, "Native Cordis");
    }
    const broken = await run(
      "alpha",
      "export function apply(){throw new Error('isolated failure')}",
      "2",
    );
    assert.equal(broken.status, 400);
    assert.match(await broken.text(), /isolated failure/);
    assert.equal((await run("alpha", source)).status, 200);
    const missing = await run(
      "alpha",
      "export const inject=['secrets'];export function apply(){}",
      "3",
    );
    assert.equal(missing.status, 400);
  } finally {
    await runtime.dispose();
  }
});
