import { LlmError } from '@deepseek-ai/dsh-llm';

/** workerd has no redirect:error; manually reject redirects without forwarding credentials. */
export async function fetchProvider(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new LlmError('Model provider redirects are refused', 'TRANSPORT');
  }
  return response;
}
