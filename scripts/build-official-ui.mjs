import { build } from "tsdown";
import { tsImport } from "tsx/esm/api";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {modelsSettingsPlatform} from "./models-settings-platform.mjs";
import {pluginInventoryPlatform} from "./plugin-inventory-platform.mjs";
import { officialUiRoster } from "./official-ui-roster.mjs";

const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(
  readFileSync(resolve(root, ".generated/upstream-source.json"), "utf8"),
);
const remoteManifest = JSON.parse(
  readFileSync(
    resolve(root, ".generated/official-remotes/manifest.json"),
    "utf8",
  ),
);
if (remoteManifest.upstream !== source.commit)
  throw new Error(
    "Official Remote ABI is stale; run npm run build:official-ui",
  );
const sourcePaths = JSON.parse(
  readFileSync(
    resolve(root, ".generated/upstream.source.tsconfig.json"),
    "utf8",
  ),
).compilerOptions.paths;
const remotePaths = JSON.parse(
  readFileSync(
    resolve(root, ".generated/official-remote.source.tsconfig.json"),
    "utf8",
  ),
).compilerOptions.paths;
const configPath = resolve(root, ".generated/official-ui.source.tsconfig.json");
writeFileSync(
  configPath,
  JSON.stringify(
    { compilerOptions: { paths: { ...sourcePaths, ...remotePaths } } },
    null,
    2,
  ) + "\n",
);
// The official Web build's public client values: the DeepSeek Harness brand and
// title, and the exact upstream commit and version these bundles are built from.
Object.assign(process.env, {
  DSH_CLIENT_BUILD_PROFILE: "official",
  DSH_CLIENT_TITLE: "DeepSeek Harness",
  DSH_CLIENT_COMMIT_HASH: source.commit,
  DSH_CLIENT_VERSION: JSON.parse(readFileSync(resolve(source.directory, "package.json"), "utf8")).version,
});
const roster = officialUiRoster(source.directory);
const output = resolve(root, ".generated/official-ui");
mkdirSync(output, { recursive: true });
const failures = [];
for (const row of roster) {
  try {
    // Keep the official package's build configuration, including CSS lifecycle,
    // module-table factories, private chunks and document-preview workers.
    const module = await tsImport(
      pathToFileURL(resolve(row.directory, "tsdown.config.ts")).href,
      import.meta.url,
    );
    const configs =
      typeof module.default === "function"
        ? module.default({})
        : module.default;
    const client = (Array.isArray(configs) ? configs : [configs]).find(
      (config) =>
        config.name?.endsWith("/client") && config.platform === "browser",
    );
    if (!client)
      throw new Error("Official browser bundle configuration not found");
    await build({
      ...client,
      cwd: row.directory,
      config: false,
      outDir: resolve(output, relative(source.directory, row.directory)),
      tsconfig: configPath,
      plugins: [
        modelsSettingsPlatform,
        pluginInventoryPlatform,
        {
          name: "weft-generated-official-remotes",
          resolveId: {
            order: "pre",
            handler(specifier) {
              const target = remotePaths[specifier]?.[0];
              return target ? resolve(root, ".generated", target) : null;
            },
          },
        },
        client.plugins,
      ],
    });
    console.log(`Official client built: ${row.id}`);
  } catch (error) {
    failures.push({
      id: row.id,
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`Official client failed: ${row.id}`);
  }
}
writeFileSync(
  resolve(output, "build-report.json"),
  JSON.stringify(
    { upstream: source.commit, entries: roster, failures },
    null,
    2,
  ) + "\n",
);
if (failures.length)
  throw new Error(
    `${failures.length}/${roster.length} official client bundles failed; see .generated/official-ui/build-report.json`,
  );
console.log(
  `Built all ${roster.length} official client entries with their own build presets.`,
);
