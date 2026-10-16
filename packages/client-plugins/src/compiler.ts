import { transform } from "sucrase";
import { parse } from "acorn";
import sdk from "../sdk.json";

export const browserImports: Record<string, string> = Object.fromEntries(
  Object.entries(sdk).map(([name, entry]) => [
    name,
    `/assets/ui-runtime/${entry}.js`,
  ]),
);

/** One self-contained browser entry; never evaluates agent code in workerd. */
export function compileClientPlugin(source: string): string {
  const output = transform(source, {
    transforms: ["typescript", "jsx"],
    filePath: "plugin.tsx",
    production: true,
    jsxRuntime: "automatic",
    keepUnusedImports: true,
  }).code;
  const tree = parse(output, { ecmaVersion: "latest", sourceType: "module" });
  const replacements: { start: number; end: number; value: string }[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const value = node as Record<string, unknown>;
    if (value.type === "ImportExpression")
      throw new Error(
        "Dynamic imports are unavailable in client plugin entries",
      );
    if (
      (value.type === "ImportDeclaration" ||
        value.type === "ExportNamedDeclaration" ||
        value.type === "ExportAllDeclaration") &&
      value.source
    ) {
      const literal = value.source as {
        start: number;
        end: number;
        value: string;
      };
      const target = browserImports[literal.value];
      if (
        !Object.hasOwn(browserImports, literal.value) ||
        typeof target !== "string"
      )
        throw new Error(`Unsupported browser import: ${literal.value}`);
      replacements.push({
        start: literal.start,
        end: literal.end,
        value: JSON.stringify(target),
      });
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "source" || typeof child === "object") walk(child);
  }
  walk(tree);
  let compiled = output;
  for (const item of replacements.sort((a, b) => b.start - a.start))
    compiled =
      compiled.slice(0, item.start) + item.value + compiled.slice(item.end);
  return compiled;
}
