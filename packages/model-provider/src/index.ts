import { z } from 'zod';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { safeProviderError } from '../../native-models/src/index.ts';

// Replaced with a literal by the build. Production cannot enable validation adapters.
declare const WEFT_VALIDATION_BUILD: boolean;
export interface ModelEnvironment {
  MODEL_BACKEND?: string;
  MODEL_TURN_TIMEOUT_MS?: string;
}

export class ModelConfigurationError extends Error {
  constructor(readonly code: 'MODEL_NOT_CONFIGURED' | 'MODEL_CONFIGURATION_INVALID') {
    super(code === 'MODEL_NOT_CONFIGURED' ? 'Configure an API key in Settings → Models for this environment' : 'Invalid environment model configuration');
  }
}

/** The whole-turn deadline; validation builds may shorten it for deadline tests. */
export function turnTimeoutFor(env: ModelEnvironment): number {
  return WEFT_VALIDATION_BUILD && env.MODEL_TURN_TIMEOUT_MS ? z.coerce.number().int().min(1).max(600_000).parse(env.MODEL_TURN_TIMEOUT_MS) : 180_000;
}

export interface TurnFailure { code: string; message: string; status: number }
export function turnFailure(error: unknown): TurnFailure {
  if (error instanceof AggregateError) return turnFailure(error.errors[0]);
  if (error instanceof ModelConfigurationError) return { code: error.code, message: error.message, status: 503 };
  if (error instanceof LlmError) {
    const safe = safeProviderError(error);
    if (safe.code === 'MISSING_CREDENTIAL') return { code: 'MODEL_NOT_CONFIGURED', message: safe.message, status: 503 };
    const status = safe.code === 'RATE_LIMIT' ? 429 : safe.code === 'TIMEOUT' ? 504 : 502;
    return { code: safe.code, message: safe.message, status };
  }
  return { code: 'TURN_FAILED', message: 'Harness turn failed', status: 500 };
}
