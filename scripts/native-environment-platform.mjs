import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Original environment services with scoped filesystem, point reads and durable revisions. */
export const nativeEnvironmentPlatform = {
  name: 'harness-native-environment-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/workspace\/workspace\/src\/(index|entity|paths)\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      if (!source.includes("from 'node:fs/promises'")) throw new Error('Workspace filesystem seam changed');
      if (path.endsWith('/index.ts')) {
        const reads = [
          ['    const headers = await this.listStoredHeaders()\n    await this.indexHeaders(headers)\n    const header = this.headers.get(id)', '    const snapshot = await this.ctx.sessionPersistence.stat(id)\n    if (snapshot !== undefined) await this.indexHeader(snapshot.header)\n    const header = this.headers.get(id)'],
          ['    await this.indexHeaders(await this.listStoredHeaders())\n    return this.headers.has(id)', '    const snapshot = await this.ctx.sessionPersistence.stat(id)\n    if (snapshot !== undefined) await this.indexHeader(snapshot.header)\n    return this.headers.has(id)'],
        ];
        for (const [before, after] of reads) {
          if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('Workspace header read seam changed');
          source = source.replace(before, after);
        }
      }
      return {contents: source.replace("from 'node:fs/promises'", `from ${JSON.stringify(resolve('packages/native-environment/src/workspace-fs.ts'))}`), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onLoad({filter: /packages\/settings\/settings\/src\/index\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      const revision = 'const revision = previous === undefined ? 0 : previous.revision + Number(previous.raw !== raw)';
      const start = source.indexOf('  private async importLegacyDocument(): Promise<void> {');
      const end = source.indexOf('\n  /** Register the calling plugin', start);
      if (!source.includes(revision) || start < 0 || end < 0) throw new Error('Settings platform seam changed');
      source = source.slice(0, start) + '  private async importLegacyDocument(): Promise<void> { /* No legacy host files in Workers. */ }\n' + source.slice(end);
      source = source.replace(revision, 'const revision = this.ownerContext.weftSettingsPersistence.revision(entry.options.id)');
      const inject = "static inject = ['configEditor', 'profileContext']";
      if (!source.includes(inject)) throw new Error('Settings dependencies changed');
      source = source.replace(inject, "static inject = ['configEditor', 'weftSettingsPersistence']");
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
