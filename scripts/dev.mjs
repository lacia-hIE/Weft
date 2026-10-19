import { loadAndParseConfig } from "@cloudflare/config";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

const parsed = await loadAndParseConfig(resolve("cloudflare.config.ts"), {
  isPreview: false,
  mode: "development",
});
if (!parsed.result.success || !parsed.result.data.worker)
  throw new Error("Invalid Cloudflare configuration");
const worker = parsed.result.data.worker;
const bindings = {},
  durableObjects = {};
for (const [name, binding] of Object.entries(worker.env ?? {})) {
  if (binding.type === "text") bindings[name] = binding.value;
  if (binding.type === "secret" && process.env[name])
    bindings[name] = process.env[name];
  if (binding.type === "durable-object")
    durableObjects[name] = {
      className: binding.exportName,
      scriptName: worker.name,
      useSQLite: true,
    };
}
const options = convertV4MiniflareOptions({
  host: "127.0.0.1",
  port: 8787,
  workers: [
    {
      name: worker.name,
      modules: true,
      scriptPath: resolve("dist/worker.js"),
      compatibilityDate: worker.compatibilityDate,
      compatibilityFlags: worker.compatibilityFlags,
      access: worker.access.dev,
      bindings,
      durableObjects,
      serviceBindings: { UI: "assets" },
    },
    {
      name: "assets",
      modules: true,
      scriptPath: resolve("dist/assets-worker.js"),
      compatibilityDate: "2026-07-30",
      assets: { directory: resolve("dist/public"), binding: "ASSETS", run_worker_first: true, routerConfig: {has_user_worker: true}, assetConfig: {html_handling: "none", not_found_handling: "none"} },
    },
  ],
});
for (const item of options.workers)
  item.dev = { ...item.dev, unsafeRegisterWorker: false };
const runtime = new Miniflare({
  ...options,
  resourcePersistencePath: resolve(".cloudflare/local-state"),
});
console.log(`Local workerd ready: ${await runtime.ready}`);
const stop = async () => {
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
