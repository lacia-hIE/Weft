declare module 'weft:official-deliverables' {
  import type { Context } from '@deepseek-ai/cordis';
  /** The official deliverables Host half (`@deepseek-ai/dsh-client-ui-deliverables`); see scripts/native-changes-platform.mjs. */
  export const inject: string[];
  export function apply(ctx: Context): void;
}
