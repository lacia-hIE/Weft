import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import ts from "typescript";

/** The exact static module table shared by official bundles and the Web kernel. */
export function officialPlatformModules(upstreamDirectory) {
  const source = ts.createSourceFile(
    "platform.ts",
    readFileSync(
      resolve(upstreamDirectory, "packages/client/web/src/platform.ts"),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) => declaration.name.getText(source) === "PLATFORM_MODULES",
    );
  const initializer = declaration?.initializer;
  const array =
    initializer && ts.isAsExpression(initializer)
      ? initializer.expression
      : initializer;
  if (
    !array ||
    !ts.isArrayLiteralExpression(array) ||
    !array.elements.every(ts.isStringLiteral)
  )
    throw new Error("Unsupported official platform module declaration");
  return array.elements.map((element) => element.text);
}

/** Read the official browser roster; activation additionally honors the Web profile. */
export function officialUiRoster(upstreamDirectory, {profile = 'all'} = {}) {
  if (!['all', 'web'].includes(profile)) throw new Error('Unsupported client profile');
  const baseline = new Set(officialPlatformModules(upstreamDirectory));
  const packages = new Map();
  const packageRoot = resolve(upstreamDirectory, "packages");
  for (const group of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(resolve(packageRoot, group.name), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(packageRoot, group.name, entry.name);
      if (!existsSync(resolve(directory, "package.json"))) continue;
      const manifest = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      packages.set(manifest.name, { manifest, directory });
    }
  }
  const patch = parse(
    readFileSync(
      resolve(packageRoot, "bundle/web-app/cordis.patch.yml"),
      "utf8",
    ),
    {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
    },
  );
  const names = new Set();
  const disabled = new Set();
  const collect = (rows) => {
    for (const row of rows) {
      if (row.insert) collect(row.insert);
      if (
        row.name &&
        packages.get(row.name)?.manifest.dsh?.client?.platform === "web"
      ) {
        if (profile === 'web' && row.disabled !== undefined && row.disabled !== false) {
          // Interpret only the pinned official profile condition, never eval
          // arbitrary YAML expressions in a build or the Cloudflare runtime.
          if (row.disabled !== true && row.disabled !== "ctx.get('profileContext')?.name !== 'desktop'")
            throw new Error(`Unsupported Web activation condition for ${row.name}`);
          disabled.add(row.name);
        } else names.add(row.name);
      }
    }
  };
  collect(patch);
  const visit = (name) => {
    const record = packages.get(name);
    if (!record?.manifest.dsh?.client)
      throw new Error(`Missing official client declaration: ${name}`);
    if (record.manifest.dsh.client.platform !== "web")
      throw new Error(`Unexpected client platform: ${name}`);
    for (const dependency of record.manifest.dsh.client.inject ?? []) {
      if (baseline.has(dependency)) continue;
      if (names.has(dependency)) continue;
      if (disabled.has(dependency)) throw new Error(`Active Web client ${name} requires disabled ${dependency}`);
      names.add(dependency);
      visit(dependency);
    }
  };
  for (const name of names) visit(name);
  return [...names].sort().map((name) => {
    const { manifest, directory } = packages.get(name);
    return { id: name, directory, ...manifest.dsh.client };
  });
}
