import { Context } from '@deepseek-ai/cordis';
import WebRuntime from '@deepseek-ai/dsh-web';
import * as WebSearchDeepSeek from '@deepseek-ai/dsh-web-search-deepseek';
import * as WebDeepSeekApi from '@deepseek-ai/dsh-web-deepseek-api';
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import { createEntry, workerdLoader } from '../../native-profile/src/loader.ts';

/**
 * The official search and fetch providers, as every Session world registers
 * them: `web-search-deepseek`, `web-deepseek-api` and `web-fetch-http` are
 * fixed rows of the official profile that an environment cannot disable.
 * Registration reads no settings or credentials, so default rows report the
 * same ids, titles and descriptions a Session would.
 */
const PROVIDER_ROWS = [
  {id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', module: WebSearchDeepSeek},
  {id: 'web-deepseek-api', name: '@deepseek-ai/dsh-web-deepseek-api', module: WebDeepSeekApi},
  {id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http', module: WebFetchHttp},
] as const;

/**
 * Answer the Host-wide `web/listProviders` Remote that the official Web search
 * settings page reads. Nothing in this world searches or fetches.
 * @returns the original `listProviders()` value.
 */
export async function listWebProviders(): Promise<unknown> {
  const ctx = new Context();
  try {
    await ctx.plugin(WebRuntime);
    const loader = await workerdLoader(ctx, Object.fromEntries(PROVIDER_ROWS.map(row => [row.name, row.module])));
    for (const row of PROVIDER_ROWS) await createEntry(loader, {id: row.id, name: row.name, config: {}});
    return ctx.web.listProviders();
  } finally {
    await ctx.fiber.dispose();
  }
}
