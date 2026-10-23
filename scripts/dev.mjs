import { loadAndParseConfig } from "@cloudflare/config";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";
import {readdirSync, readFileSync} from 'node:fs';
import {deployment} from './deployment-config.ts';

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
  port: Number(process.env.WEFT_DEV_PORT ?? 8787),
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
      workerLoaders: {LOADER: {}},
      d1Databases: {CONFIG_DB: deployment.databaseName},
      r2Buckets: {PLUGIN_ARTIFACTS: deployment.artifactBucketName},
      images: {binding: 'IMAGES'},
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
  resourcePersistencePath: resolve(process.env.WEFT_DEV_STATE_DIR ?? ".cloudflare/local-state"),
});
try {
  await runtime.ready;
  const db = await runtime.getD1Database('CONFIG_DB', worker.name);
  await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map(row => row.name));
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const statements = readFileSync(resolve('migrations', name), 'utf8').replace(/--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name)]);
  }
  console.log(`Local workerd ready: ${await runtime.ready}`);
} catch (error) {
  await runtime.dispose();
  throw error;
}
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
