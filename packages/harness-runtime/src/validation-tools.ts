import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Keyless integration probe whose identity is bound by the host, not tool arguments. */
export function registerIdentityTool(ctx: Context, tenantId: string): void {
  ctx.tools.register(defineTool({
    name: 'tenant_identity',
    description: 'Return the tenant identity bound by the trusted host.',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { tenantId: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.tenantId }],
    },
    execute: async () => ({ tenantId }),
  }));
}
