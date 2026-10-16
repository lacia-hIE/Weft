import { z } from 'zod';
import { LlmError, type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { DeepSeekAdapter } from '@weft/upstream/packages/llm/llm-deepseek/src/adapter.ts';
import { resolveAdapterOptions } from '@weft/upstream/packages/llm/llm-deepseek/src/config.ts';
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

export interface ResolvedModel extends Pick<RuntimeOptions, 'model' | 'adapter'> { turnTimeoutMs: number }

/** Host-owned resolution: HTTP clients cannot select credentials or provider endpoints. */
export function resolveTenantModel(env: ModelEnvironment, tenantId: string, selectedModel?: { provider: "deepseek"; name: string }): ResolvedModel {
  if (env.MODEL_BACKEND === 'scripted') {
    return { model: { provider: 'validation', model: 'scripted' }, adapter: new ScriptedAdapter(), turnTimeoutMs: 60_000 };
  }
  if (env.MODEL_BACKEND !== 'deepseek') throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
  try {
    const registry = env.TENANT_MODEL_CONFIG_JSON ? registrySchema.parse(JSON.parse(env.TENANT_MODEL_CONFIG_JSON)) : undefined;
    // An explicit registry is exclusive: tenants absent from it never inherit the shared key.
    const config = registry && Object.hasOwn(registry, tenantId) ? registry[tenantId] : undefined;
    const apiKey = registry ? config?.apiKey : env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
    const model = selectedModel?.name ?? config?.model ?? env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    const baseURL = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic';
    // HTTPS is mandatory, including custom gateways. No client-provided URL is accepted.
    if (new URL(baseURL).protocol !== 'https:' || !model.trim()) throw new Error('Invalid route');
    const connection = resolveAdapterOptions({
      baseURL, maxTokens: 8192, thinking: 'disabled', reasoningEffort: 'off',
      streamIdleTimeoutMs: duration.parse(env.MODEL_IDLE_TIMEOUT_MS ?? '60000'),
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    });
    const adapter = new SafeDeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: { 'x-api-key': apiKey } }),
      // Tenant-scoped pseudonymous id; never send the Access email or user id to the model provider.
      resolveUserId: () => tenantId as AnonymousUserId,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    return { model: { provider: 'deepseek', model }, adapter, turnTimeoutMs: duration.parse(env.MODEL_TURN_TIMEOUT_MS ?? '180000') };
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
