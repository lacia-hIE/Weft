import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Extract the pinned provider's DDL, keeping the canonical database outside it. */
export function prepareQuerySchema(upstreamDirectory) {
  const source = readFileSync(resolve(upstreamDirectory, 'packages/session-query/session-query-sqlite/src/schema.ts'), 'utf8');
  const version = /SESSION_QUERY_SQLITE_SCHEMA_VERSION = (\d+)/.exec(source)?.[1];
  const begin = source.indexOf('function ensurePersistentSchema(');
  const end = source.indexOf('\nfunction quoteIdentifier(', begin);
  if (!version || begin < 0 || end < 0) throw new Error('Upstream search schema seam changed');
  const statements = [...source.slice(begin, end).matchAll(/db\.exec\((['`])([\s\S]*?)\1\)/g)]
    .map(match => match[2].trim()).filter(sql => /^(CREATE|INSERT)\b/.test(sql));
  if (statements.length !== 6 || !statements.some(sql => sql.includes('tokenize = \'unicode61\''))) throw new Error('Upstream search DDL changed; review the durable index');
  writeFileSync('.generated/official-search-schema.ts', `export const searchSchemaVersion = ${version};\nexport const searchSchema: readonly string[] = ${JSON.stringify(statements)};\n`);
}

/** Replace only Node database opening and SQL transaction ownership. */
export const nativeQueryPlatform = {
  name: 'harness-native-query-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/session-query\/session-query-sqlite\/src\/schema\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const constants = source.match(/export const SESSION_QUERY_SQLITE_(?:APPLICATION_ID|SCHEMA_VERSION) = [0-9a-fx]+/g);
      if (constants?.length !== 2) throw new Error('Upstream search schema constants changed');
      return {contents: constants.join(';\n') + ";\nexport function openSearchDatabase() {throw new Error('Search requires the durable database provider');}", loader: 'ts'};
    });
    builder.onLoad({filter: /packages\/session-query\/session-query-sqlite\/src\/index\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      const substitutions = [
        ['await openSearchDatabase(this.config.path, this.config.journalMode)', 'this.ctx.weftSessionSearchDatabase.open()'],
        ["      let began = false\n      try {\n        db.exec('BEGIN IMMEDIATE')\n        began = true", '      try {\n        this.ctx.weftSessionSearchDatabase.transactionSync(() => {'],
        ["        db.exec('COMMIT')\n      } catch (error: unknown) {", '        })\n      } catch (error: unknown) {'],
        ["        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */\n        if (began) {\n          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */\n          try {\n            db.exec('ROLLBACK')\n          } catch {\n            // The original SQLite failure remains the actionable cause.\n          }\n        }\n", ''],
      ];
      for (const [before, after] of substitutions) {
        if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('Upstream SQLite search platform seam changed; review the durable adaptation');
        source = source.replace(before, after);
      }
      if (source.includes("db.exec('BEGIN") || source.includes("db.exec('COMMIT") || source.includes("db.exec('ROLLBACK")) throw new Error('Unadapted search transaction');
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
