import { z } from 'zod';
import { LlmError, ReasoningEffortId, type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { DeepSeekAdapter } from '@weft/upstream/packages/llm/llm-deepseek/src/adapter.ts';
import { resolveAdapterOptions } from '@weft/upstream/packages/llm/llm-deepseek/src/config.ts';
import type {DeepSeekAdapterOptions} from '@weft/upstream/packages/llm/llm-deepseek/src/types.ts';
import type { Options as DeepSeekOptions } from '@weft/upstream/packages/llm/llm-deepseek/src/config.ts';
import { ScriptedAdapter } from '../../harness-runtime/src/scripted-adapter.ts';
import type { RuntimeOptions } from '../../harness-runtime/src/runtime.ts';

// Replaced with a literal by the build. Production cannot enable validation adapters.
declare const WEFT_VALIDATION_BUILD: boolean;
export interface ModelEnvironment {
  MODEL_BACKEND?: string;
  MODEL_TURN_TIMEOUT_MS?: string;
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
  SERVER: 'Model provider is unavailable',
  TRANSPORT: 'Model provider connection failed',
};

/** Remove provider-controlled messages and causes before Harness can persist them. */
function safeProviderError(error: unknown): LlmError {
  const code = error instanceof LlmError && Object.hasOwn(messages, error.code) ? error.code : 'PROVIDER_ERROR';
  return new LlmError(messages[code] ?? 'Model provider request failed', code);
}

class SafeDeepSeekAdapter extends DeepSeekAdapter {
  private async *safe(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    try { yield* stream; } catch (error) { throw safeProviderError(error); }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.safe(super.stream(options)); }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal);
    return { model: call.model, stream: options => this.safe(call.stream(options)) };
  }
}

export class ModelConfigurationError extends Error {
  constructor(readonly code: 'MODEL_NOT_CONFIGURED' | 'MODEL_CONFIGURATION_INVALID') {
    super(code === 'MODEL_NOT_CONFIGURED' ? 'Configure an API key in Settings → Models for this environment' : 'Invalid environment model configuration');
  }
}

export interface ResolvedModel extends Pick<RuntimeOptions, 'model' | 'adapter'> {
  turnTimeoutMs: number;
  refresh?: (configuration: EnvironmentModelConfig) => void;
  currentSelection?: () => ModelSelection;
}

export interface EnvironmentModelConfig {
  providerOptions: DeepSeekOptions;
  apiKey?: string;
  defaultModel?: {provider: string; model: string; reasoningEffort?: string};
}
/** Preserve typed model failures across the Durable Object RPC serialization boundary. */
export async function readEnvironmentModelConfiguration(response: Response): Promise<EnvironmentModelConfig> {
  if (!response.ok) {
    const failure = z.object({code: z.enum(['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_INVALID'])}).parse(await response.json());
    throw new ModelConfigurationError(failure.code);
  }
  return await response.json() as EnvironmentModelConfig;
}

/** Resolve only the environment settings persisted by the original Models editor. */
export function resolveTenantModel(env: ModelEnvironment, tenantId: string, selectedModel?: { provider: "deepseek"; name: string }, settings?: EnvironmentModelConfig, requireCredential = true, capabilities: Pick<DeepSeekAdapterOptions, 'resolveAttachments' | 'resolveImageAccess' | 'resolveFiles'> = {}): ResolvedModel {
  if (WEFT_VALIDATION_BUILD && env.MODEL_BACKEND === 'scripted') {
    return { model: { provider: 'validation', model: 'scripted' }, adapter: new ScriptedAdapter(), turnTimeoutMs: 60_000 };
  }
  try {
    const apiKey = settings?.apiKey;
    if (!apiKey && requireCredential) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
    const model = settings?.defaultModel?.model ?? selectedModel?.name ?? 'deepseek-flash';
    const baseURL = settings?.providerOptions.baseURL ?? 'https://api.deepseek.com/anthropic';
    // HTTPS is mandatory for the endpoint saved in this environment’s Models settings.
    if (new URL(baseURL).protocol !== 'https:' || !model.trim()) throw new Error('Invalid route');
    const connectionFor = (configuration: EnvironmentModelConfig | undefined) => resolveAdapterOptions({
      maxTokens: 8192, thinking: 'disabled', reasoningEffort: 'off',
      streamIdleTimeoutMs: 60_000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      ...configuration?.providerOptions,
      baseURL: configuration?.providerOptions.baseURL ?? 'https://api.deepseek.com/anthropic',
    });
    let current = settings;
    let connection = connectionFor(settings);
    const credentials = new WeakMap<typeof connection, string>();
    if (apiKey) credentials.set(connection, apiKey);
    const currentSelection = (): ModelSelection => {
      const selection = current?.defaultModel;
      return {provider: 'deepseek-official', model: selection?.model ?? selectedModel?.name ?? 'deepseek-flash',
        ...(selection?.reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(selection.reasoningEffort)})};
    };
    const adapter: SafeDeepSeekAdapter = new SafeDeepSeekAdapter({
      ...capabilities,
      options: () => connection,
      resolveAuth: async snapshot => {
        const key = credentials.get(snapshot);
        if (!key) throw new LlmError('No model credential configured', 'MISSING_CREDENTIAL');
        return {headers: {'x-api-key': key}};
      },
      discoverModels: async provider => {
        const ids = [...new Set([...connection.models.map(entry => entry.id), currentSelection().model])];
        return Promise.all(ids.map(id => adapter.resolveModel(provider, id)));
      },
      // Tenant-scoped pseudonymous id; never send the Access email or user id to the model provider.
      resolveUserId: () => tenantId as AnonymousUserId,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    if (settings?.defaultModel && settings.defaultModel.provider !== 'deepseek-official') throw new Error('Unsupported provider');
    return {model: currentSelection(), adapter, turnTimeoutMs: WEFT_VALIDATION_BUILD && env.MODEL_TURN_TIMEOUT_MS ? z.coerce.number().int().min(1).max(600_000).parse(env.MODEL_TURN_TIMEOUT_MS) : 180_000, currentSelection,
      refresh: configuration => {
        if (!configuration.apiKey) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
        const snapshot = connectionFor(configuration);
        if (new URL(snapshot.baseURL).protocol !== 'https:' || (configuration.defaultModel && configuration.defaultModel.provider !== 'deepseek-official')) throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
        credentials.set(snapshot, configuration.apiKey);
        current = configuration; connection = snapshot;
      }};
  } catch (error) {
    if (error instanceof ModelConfigurationError) throw error;
    throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
  }
}

export interface TurnFailure { code: string; message: string; status: number }
export function turnFailure(error: unknown): TurnFailure {
  if (error instanceof AggregateError) return turnFailure(error.errors[0]);
  if (error instanceof ModelConfigurationError) return { code: error.code, message: error.message, status: 503 };
  if (error instanceof LlmError) {
    const safe = safeProviderError(error);
    const status = safe.code === 'RATE_LIMIT' ? 429 : safe.code === 'TIMEOUT' ? 504 : 502;
    return { code: safe.code, message: safe.message, status };
  }
  return { code: 'TURN_FAILED', message: 'Harness turn failed', status: 500 };
}
