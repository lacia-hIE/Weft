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

export interface ModelEnvironment {
  MODEL_BACKEND?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  MODEL_IDLE_TIMEOUT_MS?: string;
  MODEL_TURN_TIMEOUT_MS?: string;
  TENANT_MODEL_CONFIG_JSON?: string;
}

const tenantConfig = z.object({ apiKey: z.string().trim().min(1), model: z.string().min(1).optional() }).strict();
const registrySchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), tenantConfig);
const duration = z.coerce.number().int().min(1).max(600_000);
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
    super(code === 'MODEL_NOT_CONFIGURED' ? 'No model credential configured for this tenant' : 'Invalid server model configuration');
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

/** Only this host-owned layer may supply shared credential fallbacks. */
export function tenantModelHost(env: ModelEnvironment, tenantId: string) {
  try {
    const registry = env.TENANT_MODEL_CONFIG_JSON ? registrySchema.parse(JSON.parse(env.TENANT_MODEL_CONFIG_JSON)) : undefined;
    const config = registry && Object.hasOwn(registry, tenantId) ? registry[tenantId] : undefined;
    return {apiKey: registry ? config?.apiKey : env.DEEPSEEK_API_KEY?.trim(), model: config?.model ?? env.DEEPSEEK_MODEL ?? 'deepseek-flash', baseURL: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic'};
  } catch { throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID'); }
}

/** Host-owned resolution: HTTP clients cannot select credentials or provider endpoints. */
export function resolveTenantModel(env: ModelEnvironment, tenantId: string, selectedModel?: { provider: "deepseek"; name: string }, settings?: EnvironmentModelConfig, requireCredential = true, capabilities: Pick<DeepSeekAdapterOptions, 'resolveAttachments' | 'resolveImageAccess' | 'resolveFiles'> = {}): ResolvedModel {
  if (env.MODEL_BACKEND === 'scripted') {
    return { model: { provider: 'validation', model: 'scripted' }, adapter: new ScriptedAdapter(), turnTimeoutMs: 60_000 };
  }
  if (env.MODEL_BACKEND !== 'deepseek') throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
  try {
    const host = tenantModelHost(env, tenantId);
    const apiKey = settings ? settings.apiKey : host.apiKey;
    if (!apiKey && requireCredential) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
    const model = settings?.defaultModel?.model ?? selectedModel?.name ?? host.model;
    const baseURL = settings?.providerOptions.baseURL ?? host.baseURL;
    // HTTPS is mandatory, including custom gateways. No client-provided URL is accepted.
    if (new URL(baseURL).protocol !== 'https:' || !model.trim()) throw new Error('Invalid route');
    const connectionFor = (configuration: EnvironmentModelConfig | undefined) => resolveAdapterOptions({
      maxTokens: 8192, thinking: 'disabled', reasoningEffort: 'off',
      streamIdleTimeoutMs: duration.parse(env.MODEL_IDLE_TIMEOUT_MS ?? '60000'),
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      ...configuration?.providerOptions,
      baseURL: configuration?.providerOptions.baseURL ?? host.baseURL,
    });
    let current = settings;
    let connection = connectionFor(settings);
    const credentials = new WeakMap<typeof connection, string>();
    if (apiKey) credentials.set(connection, apiKey);
    const currentSelection = (): ModelSelection => {
      const selection = current?.defaultModel;
      return {provider: 'deepseek-official', model: selection?.model ?? selectedModel?.name ?? host.model,
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
    return {model: currentSelection(), adapter, turnTimeoutMs: duration.parse(env.MODEL_TURN_TIMEOUT_MS ?? '180000'), currentSelection,
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
