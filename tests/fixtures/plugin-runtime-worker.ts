import {Context} from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {readPluginRuntime} from '../../packages/native-composition/src/runtime.ts';

export default {
  async fetch(): Promise<Response> {
    const ctx = new Context();
    try {
      await ctx.plugin({name: 'fixture-active', apply() {}});
      ctx.plugin({name: 'fixture-pending', inject: ['fixtureUnavailable'], apply() {}});
      try {await ctx.plugin({name: 'fixture-failed', apply(_ctx: Context, _config: {password: string}) {throw new Error('apiKey=fixture-private-secret');}}, {password: 'another-private-secret'});} catch {}
      try {await ctx.plugin({name: 'fixture-config', Config: z.object({requiredField: z.string().required()}), apply() {}});} catch {}
      try {await ctx.plugin({name: 'fixture-custom-error', apply() {throw Object.assign(new Error('private-secret'), {name: 'private-secret-name', code: 'private-secret-code'});}});} catch {}
      return Response.json(await readPluginRuntime(ctx));
    } finally {await ctx.fiber.dispose();}
  },
};
