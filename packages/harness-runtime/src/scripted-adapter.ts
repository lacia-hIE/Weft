import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';

/** Deterministic model substitute for keyless workerd validation, never a production provider. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override async listModels(provider: string) { return [await this.resolveModel(provider, 'scripted')]; }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.requests.push(options);
    const last = options.messages.at(-1);
    if (last?.role !== 'tool') {
      const signatureFixture = options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('WEFT_REASONING_SIGNATURE_FIXTURE')));
      const toolIndex = signatureFixture ? 1 : 0;
      if (signatureFixture) {
        const text = '<signature>weft-signature-metadata</signature>\n\nVisible reasoning paragraph\n\n**Second reasoning paragraph**';
        yield {type: 'block-start', index: 0, blockType: 'reasoning'};
        yield {type: 'reasoning-delta', index: 0, text};
        yield {type: 'block-end', index: 0, block: {type: 'reasoning', text}};
      }
      const id = ToolCallId(crypto.randomUUID());
      const taskFixture = options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('WEFT_DURABLE_TASK_FIXTURE')));
      const name = taskFixture ? 'javascript_task' : 'tenant_identity';
      const args = taskFixture ? JSON.stringify({operation: 'start', source: `import {request} from 'ws:approval'; export default () => request('Keep the browser fixture task waiting');`}) : '{}';
      yield { type: 'block-start', index: toolIndex, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: toolIndex, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: toolIndex, block: { type: 'tool-call', id, name, arguments: args } };
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
