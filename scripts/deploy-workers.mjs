import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run"))
  throw new Error("Only --dry-run is supported");

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/cf/bin/cf", import.meta.url));
const assetsEnv = { ...process.env };
// Workers Builds scopes these variables to the connected main Worker. The
// private companion Worker has its own explicit name; retain the checks for main.
delete assetsEnv.WRANGLER_CI_MATCH_TAG;
delete assetsEnv.WRANGLER_CI_OVERRIDE_NAME;

for (const [workerArgs, env] of [
  [["--worker", "weft-ui-assets"], assetsEnv],
  [[], process.env],
]) {
  const result = spawnSync(
    process.execPath,
    [cli, "deploy", "--prebuilt", ...workerArgs, ...args],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
