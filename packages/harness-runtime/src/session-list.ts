import type {Context} from '@deepseek-ai/cordis';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';

const lists = new WeakMap<Context, Promise<ApiSessionList>>();
/** One original list controller per real Context; its projections (list metadata, image limits) register once before use. */
export function nativeSessionList(ctx: Context): Promise<ApiSessionList> {
  let list = lists.get(ctx);
  if (!list) {
    const created = new ApiSessionList(ctx, 8);
    list = created.initialize().then(() => created);
    lists.set(ctx, list);
    list.catch(() => { lists.delete(ctx); });
  }
  return list;
}
