import type { Context } from '@deepseek-ai/cordis';
import * as LlmDeepSeekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createEntry, workerdLoader } from '../../native-profile/src/loader.ts';

/** Profile entry ids of the official model providers; each id is also its settings namespace. */
export const DEEPSEEK_ENTRY = 'llm-deepseek';
export const PI_AI_ENTRY = 'llm-pi-ai';

/** The effective settings sections the model entries run with. */
export interface ModelSections {
  deepseek: Record<string, unknown>;
  piAi: Record<string, unknown>;
}

const messages: Record<string, string> = {
  AUTH: 'Model provider rejected its configured credential',
  QUOTA: 'Model provider quota is exhausted',
  RATE_LIMIT: 'Model provider rate limit reached',
  INVALID_REQUEST: 'Model provider rejected the request',
  CONTEXT_WINDOW_EXCEEDED: 'Model context window exceeded',
  TIMEOUT: 'Model provider stream timed out',
  ABORTED: 'Model request was cancelled',
  MALFORMED_RESPONSE: 'Model provider returned an invalid stream',
  EMPTY_RESPONSE: 'Model provider returned an empty response',
  STREAM_CLOSED: 'Model provider stream ended before completion',
  UNSUPPORTED_CONTENT: 'Model provider returned unsupported content',
  REQUEST_EXTENSION: 'Model request extension failed',
  MISSING_CREDENTIAL: 'Configure an API key in Settings → Models for this environment',
  SERVER: 'Model provider is unavailable',
  TRANSPORT: 'Model provider connection failed',
};

/** Remove provider-controlled messages and causes before the Harness persists a failure. */
export function safeProviderError(error: unknown): LlmError {
  const code = error instanceof LlmError && Object.hasOwn(messages, error.code) ? error.code : 'PROVIDER_ERROR';
  return new LlmError(messages[code] ?? 'Model provider request failed', code);
}

/**
 * Replace provider-controlled failure text with a fixed description. The
 * original `llm` service turns adapter throws into terminal finish chunks, so
 * both those chunks and anything still thrown are rewritten; machine facts
 * (code, status, retry delay) stay for retry and offload policies.
 */
async function* redacted(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const failure = chunk.reason.failure;
        yield {...chunk, reason: {...chunk.reason, failure: {...failure, message: messages[failure.code] ?? 'Model provider request failed'}}};
      } else yield chunk;
    }
  } catch (error) { throw safeProviderError(error); }
}

/**
 * Mount the official model providers as profile entries of the world's Loader,
 * so their settings namespaces, Volatile updates, directory entries and
 * discovery behave as in the original Host. Credentials resolve through the
 * world's `credentials` service. Provider failures are redacted for every route.
 * @returns a function that commits new effective settings sections to the running entries.
 */
export async function mountNativeModels(ctx: Context, sections: ModelSections): Promise<(next: ModelSections) => Promise<void>> {
  ctx.on('llm/stream', (_options, next) => redacted(next()));
  const loader = await workerdLoader(ctx, {'llm-deepseek-api-key': LlmDeepSeekApiKey, 'llm-pi-ai': LlmPiAi});
  await createEntry(loader, {id: DEEPSEEK_ENTRY, name: 'cordis:llm-deepseek-api-key', config: structuredClone(sections.deepseek)});
  await createEntry(loader, {id: PI_AI_ENTRY, name: 'cordis:llm-pi-ai', config: structuredClone(sections.piAi)});
  let current = JSON.stringify(sections);
  return async next => {
    const serialized = JSON.stringify(next);
    if (serialized === current) return;
    current = serialized;
    await loader.update(DEEPSEEK_ENTRY, {config: structuredClone(next.deepseek)});
    await loader.update(PI_AI_ENTRY, {config: structuredClone(next.piAi)});
  };
}

/** The environment model state a Session world reads from its EnvironmentDO. */
export interface EnvironmentModels extends ModelSections {
  /** The environment's effective default, including its deployment base. */
  baseModel: {provider: string; model: string; reasoningEffort?: string};
  /** The default the user saved, when there is one. */
  defaultModel?: {provider: string; model: string; reasoningEffort?: string};
}

/** The credential reference a route authenticates with, or undefined when the route uses provider-native discovery. */
export function credentialRefFor(models: EnvironmentModels, provider: string): string | undefined {
  if (provider === 'deepseek-official') return String(models.deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
  const providers = models.piAi.providers;
  const profile = providers !== null && typeof providers === 'object' ? (providers as Record<string, {apiKeyEnv?: unknown}>)[provider] : undefined;
  return typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined;
}

/**
 * The selection a Session starts from: the default the user saved, else the
 * Agent's model on the DeepSeek route, else the environment's effective default.
 */
export function defaultSelectionOf(models: EnvironmentModels, agentModel: string | undefined): {provider: string; model: string; reasoningEffort?: string} {
  if (models.defaultModel) return {...models.defaultModel};
  return agentModel ? {provider: 'deepseek-official', model: agentModel} : {...models.baseModel};
}

/** Read the model sections an EnvironmentDO returned across the RPC boundary. */
export async function readModelSections(response: Response): Promise<EnvironmentModels> {
  if (!response.ok) throw new Error('Environment model settings are unavailable');
  return await response.json() as EnvironmentModels;
}
