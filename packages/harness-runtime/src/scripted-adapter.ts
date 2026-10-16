import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';

/** Deterministic model substitute for keyless workerd validation, never a production provider. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.requests.push(options);
    const last = options.messages.at(-1);
    if (last?.role !== 'tool') {
      const id = ToolCallId(crypto.randomUUID());
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'tenant_identity', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'tenant_identity', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: `Tenant: ${text}` };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `Tenant: ${text}` } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
