import { loadAndParseConfig } from "@cloudflare/config";
import {
  cleanBuildOutputDir,
  writeRootConfig,
  writeWorkerConfig,
  writeContainerConfig,
  normalizeDirectoryName,
  getWorkerBundleDir,
  getWorkerAssetsDir,
} from "@cloudflare/build-output-utils";
import { mkdir, copyFile, cp } from "node:fs/promises";
import { resolve } from "node:path";

// The CLI currently emits only the default Worker when delegating to Wrangler.
// Produce its standard Build Output Specification for both already-bundled Workers.
export async function writeBuildOutput() {
  const root = process.cwd(),
    context = { isPreview: false, mode: undefined };
  const main = await loadAndParseConfig(
    resolve("cloudflare.config.ts"),
    context,
  );
  const assets = await loadAndParseConfig(
    resolve("apps/assets/cloudflare.config.ts"),
    context,
  );
  if (!main.result.success || !assets.result.success)
    throw new Error("Invalid Cloudflare project configuration");
  await cleanBuildOutputDir(root);
  const {
    worker: _worker,
    containers,
    ...settings
  } = main.result.data;
  await writeRootConfig(root, settings, context);
  // Container images are prebuilt and pushed (scripts/workspace-container.mjs); their configs carry registry references.
  for (const container of containers ?? []) {
    await writeContainerConfig({ root, config: container, directoryName: normalizeDirectoryName(container.name) });
  }
  for (const [parsed, directoryName, path] of [
    [main.result.data, "default", "dist/worker.js"],
    [assets.result.data, "ui", "dist/assets-worker.js"],
  ]) {
    const config = parsed.worker;
    if (!config) throw new Error("Missing worker definition");
    const bundle = getWorkerBundleDir(root, directoryName);
    await mkdir(bundle, { recursive: true });
    await copyFile(path, resolve(bundle, "worker.js"));
    await copyFile(path + ".map", resolve(bundle, "worker.js.map"));
    if (directoryName === "ui") await cp(resolve("dist/public"), getWorkerAssetsDir(root, directoryName), { recursive: true });
    await writeWorkerConfig({
      root,
      config,
      directoryName,
      manifest: {
        type: "complete",
        mainModule: "worker.js",
        modules: {
          "worker.js": { type: "esm" },
          "worker.js.map": { type: "sourcemap" },
        },
      },
    });
  }
}
