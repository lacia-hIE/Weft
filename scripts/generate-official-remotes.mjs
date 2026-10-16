import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

// Generate the official Remote ABI outside the immutable upstream checkout.
// Use the same pinned TypeScript compiler as the official generator.
const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(
  readFileSync(resolve(root, ".generated/upstream-source.json"), "utf8"),
);
const output = resolve(root, ".generated/official-remotes");
mkdirSync(output, { recursive: true });
const runner = resolve(output, "generator.mjs");
await build({
  stdin: {
    contents: `export { WorkspaceTypertGenerator, WorkspaceAnalyzer, FaceModelEmitter } from ${JSON.stringify(resolve(source.directory, "packages/typert/generator/src/index.ts"))};`,
    resolveDir: root,
  },
  outfile: runner,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["typescript", "@jridgewell/gen-mapping"],
});
const { WorkspaceTypertGenerator, WorkspaceAnalyzer, FaceModelEmitter } =
  await import(pathToFileURL(runner).href);
const registrations = new WorkspaceTypertGenerator(source.directory).discover(
  ["host"],
  (manifest) => !!manifest.exports?.["./remote"],
);
const model = new WorkspaceAnalyzer({
  root: source.directory,
  packages: registrations.map((row) => row.package),
  faces: ["host"],
  checkDiagnostics: false, // This matches the official bundle-free generator.
  rejectBuildOutputs: true,
}).analyze();
const artifacts = model.faces.flatMap((face) => {
  const emitter = new FaceModelEmitter(face);
  return face.packages.map((pkg) => ({
    ...emitter.emit(pkg.name),
    packageRoot: pkg.root,
  }));
});
const sourcePaths = {},
  typePaths = {},
  inventory = [];
for (const artifact of artifacts) {
  const directory = resolve(output, artifact.packageRoot);
  mkdirSync(directory, { recursive: true });
  const write = (name, contents) =>
    writeFileSync(resolve(directory, name), contents);
  const alias = (name, file, types) => {
    sourcePaths[name] = [
      "./" + relative(resolve(root, ".generated"), resolve(directory, file)),
    ];
    typePaths[name] = [
      "./" + relative(resolve(root, ".generated"), resolve(directory, types)),
    ];
  };
  write("typert.host.js", artifact.js);
  write("typert.host.d.ts", artifact.dts);
  alias(`${artifact.package}/typert`, "typert.host.js", "typert.host.d.ts");
  if (artifact.remote) {
    write("typert.remote-client.js", artifact.remote.js);
    write("typert.remote-client.d.ts", artifact.remote.dts);
    write("typert.remote-client.d.ts.map", artifact.remote.dtsMap);
    alias(
      `${artifact.package}/remote`,
      "typert.remote-client.js",
      "typert.remote-client.d.ts",
    );
  }
  inventory.push({ package: artifact.package, remote: !!artifact.remote });
}
writeFileSync(
  resolve(output, "manifest.json"),
  JSON.stringify({ upstream: source.commit, packages: inventory }, null, 2) +
    "\n",
);
writeFileSync(
  resolve(root, ".generated/official-remote.source.tsconfig.json"),
  JSON.stringify({ compilerOptions: { paths: sourcePaths } }, null, 2) + "\n",
);
writeFileSync(
  resolve(root, ".generated/official-remote.tsconfig.json"),
  JSON.stringify({ compilerOptions: { paths: typePaths } }, null, 2) + "\n",
);
console.log(
  `Generated ${artifacts.length} official Typert artifacts without modifying upstream.`,
);
