import { Context, Service } from '@deepseek-ai/cordis';
import type { DeepSeekFileStore } from '@weft/upstream/packages/llm/llm-deepseek/src/file-store.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The environment's harness home facts that original services read from the process home. */
    weftHarnessHome: HarnessHome
  }
}

/** Facts the original runtime keeps in its harness home, held per environment. */
export interface HarnessHomeFacts {
  /** Random id the environment persisted on first use; never derived from tenant or user identity. */
  anonymousUserId: string;
}

/**
 * Each environment is one harness home. A Worker isolate hosts many tenants'
 * objects, so these facts live on the world's context, never at module level.
 */
export class HarnessHome extends Service {
  readonly anonymousUserId: string;
  /** The environment's DeepSeek upload index and reuse store, kept in the EnvironmentDO. */
  readonly deepSeekFiles: DeepSeekFileStore | undefined;
  constructor(ctx: Context, home: HarnessHomeFacts & {deepSeekFiles?: DeepSeekFileStore}) {
    super(ctx, 'weftHarnessHome');
    this.anonymousUserId = home.anonymousUserId;
    this.deepSeekFiles = home.deepSeekFiles;
  }
}
