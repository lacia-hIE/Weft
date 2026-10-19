import type {Context} from '@deepseek-ai/cordis';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';

const lists = new WeakMap<Context, ApiSessionList>();
/** One original list controller per real Context; its projections register once. */
export function nativeSessionList(ctx: Context): ApiSessionList {
  let list = lists.get(ctx);
  if (!list) {list = new ApiSessionList(ctx, 8); lists.set(ctx, list);}
  return list;
}
