import Schema from '@deepseek-ai/schemastery';
import {background, chunks, requestId, sleep} from './shared.js';
import {captureContextEnhancementSource, enhanceContextContent, withSentAt} from './reference/context-enhancement.mjs';

const record = {parse: value => value};
const DOMAIN = {name: 'im_core', version: 1, tables: {conversations: {valueSchema: record}, seen: {valueSchema: record}}};
const SEEN_LIMIT = 2000;
/** A follow stream without frames is reopened, so a missed boundary cannot pin a stream forever. */
const FOLLOW_IDLE_MS = 600_000;

const HELP = [
  '可用命令：',
  '/new 开始一个新会话',
  '/stop 停止当前回复',
  '/steer <内容> 向当前任务补充指令',
  '/help 显示本帮助',
].join('\n');

/** Text of an assistant message's text blocks. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').trim();
}

/**
 * The shared IM bridge: one Harness Session per channel conversation, prompts
 * deduplicated by channel message id, and each finished turn delivered back
 * through the channel that owns the conversation.
 *
 * Channels register with `ctx.im.channel(name, {send, maxChars, allows})` and
 * hand inbound messages to `ctx.im.receive(...)`.
 */
class ImBridge {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config ?? {};
    this.channels = new Map();
    this.followers = new Map();
    this.closed = false;
    ctx.effect(() => () => {this.closed = true;}, 'dsh-im bridge lifetime');
    this.ready = ctx.storageDomain.open(DOMAIN).then(domain => {
      ctx.effect(() => () => domain.close(), 'dsh-im storage');
      this.conversations = domain.table('conversations');
      this.seen = domain.table('seen');
      // Replies interrupted by a restart are delivered from their durable cursor.
      for (const [key, row] of this.conversations.entries()) if (row.pending?.length) this.follow(key);
    });
    void this.ready.catch(() => {});
  }

  /**
   * Register a channel transport for this plugin's lifetime.
   * @param {string} name - channel id, such as `feishu`.
   * @param {{send(target: unknown, text: string): Promise<void>, maxChars?: number, allows?(sender: string): boolean}} channel
   */
  channel(name, channel) {
    if (this.channels.has(name)) throw new Error(`IM channel ${name} is registered twice`);
    this.channels.set(name, channel);
    return () => {if (this.channels.get(name) === channel) this.channels.delete(name);};
  }

  async send(name, target, text) {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`IM channel ${name} is not active`);
    for (const part of chunks(text, channel.maxChars ?? 2000)) await channel.send(target, part);
  }

  async catalog() {return this.ctx.sessionController.modelCatalog({});}

  /** Forget one bot's routes before removing its credentials. */
  async clear(channel) {
    await this.ready;
    for (const [key, row] of this.conversations.entries()) if (row.channel === channel) {
      this.followers.get(key)?.abort();
      this.followers.delete(key);
      await this.conversations.delete(key);
    }
    for (const key of this.seen.keys()) if (key.startsWith(channel + ':')) await this.seen.delete(key);
  }

  /**
   * Accept one inbound message. Redeliveries of the same channel message are ignored.
   * @param {{channel: string, conversation: string, title?: string, sender: string, senderName?: string, text: string, messageId: string, target: unknown, group?: boolean}} message
   * @returns {Promise<'accepted' | 'duplicate' | 'denied' | 'command' | 'failed'>}
   */
  async receive(message) {
    await this.ready;
    const channel = this.channels.get(message.channel);
    if (!channel) throw new Error(`IM channel ${message.channel} is not active`);
    const seenKey = `${message.channel}:${message.messageId}`;
    if (this.seen.get(seenKey)) return 'duplicate';
    await this.seen.put(seenKey, {at: Date.now()});
    if ([...this.seen.keys()].length > SEEN_LIMIT) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
      for (const [key] of oldest) await this.seen.delete(key);
    }
    const text = message.text.trim();
    const command = /^\/(new|stop|help|steer)\b/i.exec(text)?.[1]?.toLowerCase();
    const access = channel.access?.(message, !!command);
    if (access?.allowed === false || channel.allows && !channel.allows(message.sender)) {
      await this.send(message.channel, message.target, access?.reason === 'command-not-allowed' ? '你可以与机器人对话，但没有执行命令的权限。' : `尚未授权与此机器人对话。你的 ID：${message.sender}\n请管理员在插件设置中把它加入允许列表。`);
      return 'denied';
    }
    const key = `${message.channel}:${message.conversation}`;
    if (command === 'steer' && !text.replace(/^\/steer\b\s*/i, '').trim()) {
      await this.send(message.channel, message.target, '用法：/steer <补充内容>'); return 'command';
    }
    let row = this.conversations.get(key);
    if (command === 'help') {await this.send(message.channel, message.target, HELP); return 'command';}
    if (command === 'stop') {
      if (row) await this.ctx.sessionController.cancel({sessionId: row.sessionId});
      await this.send(message.channel, message.target, row ? '已停止当前回复。' : '当前没有进行中的会话。');
      return 'command';
    }
    if (command === 'new' || !row) {
      const preset = channel.agentPreset || this.config.agentPreset;
      let created;
      try {
        if (channel.modelSelection) {
          const selection = channel.modelSelection, catalog = await this.catalog();
          const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
          if (!model || selection.reasoningEffort !== undefined && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new Error('Configured bot model is unavailable');
        }
        created = await this.ctx.sessionController.create({cwd: channel.workspace || '/workspace', ...(preset ? {agentPreset: preset} : {})});
        if (channel.modelSelection) await this.ctx.sessionController.selectModel({sessionId: created.sessionId, ...channel.modelSelection});
      } catch {
        await this.send(message.channel, message.target, '无法创建新会话，请管理员检查工作区、Agent Preset、模型与思考强度设置。已有会话保持可用。');
        return 'failed';
      }
      this.followers.get(key)?.abort();
      this.followers.delete(key);
      row = {sessionId: created.sessionId, delivered: -1, pending: [], target: message.target, channel: message.channel, titlePrefix: this.config.titlePrefix !== false};
      await this.conversations.put(key, row);
      if (command === 'new') {
        await this.send(message.channel, message.target, '已开始新会话。');
        return 'command';
      }
    }
    const stableId = await requestId(seenKey);
    // Durable native prompt provenance lets the Host decorate automatic titles
    // without pinning an opaque sender id as an explicit user rename.
    const id = row.titlePrefix ? `${message.channel}-${stableId}` : stableId;
    row = await this.conversations.update(key, current => ({...current, target: message.target, pending: [...new Set([...(current.pending ?? []), id])].slice(-32)}));
    const body = command === 'steer' ? text.replace(/^\/steer\b\s*/i, '') : text;
    const content = message.group && message.senderName ? `${message.senderName}：${body}` : body;
    const captured = captureContextEnhancementSource({botId: channel.botId?.(), getSettings: () => channel.contextEnhancement}, message.group ? 'group' : 'direct', withSentAt(() => ({
      channel: message.channel, senderId: message.sender, senderName: message.senderName,
      conversationTitle: message.title, chatId: message.chatId ?? message.conversation, threadId: message.threadId,
    }), message.sentAt));
    const mode = command === 'steer' || channel.busyMessageMode === 'steer' && channel.access?.(message, true)?.allowed !== false ? 'steer' : 'queue';
    await this.ctx.sessionController.prompt({sessionId: row.sessionId, requestId: id, mode, content: [{type: 'text', text: enhanceContextContent(content, captured)}]});
    this.follow(key);
    return 'accepted';
  }

  /** Deliver each finished turn of a conversation's Session once, from its durable cursor. */
  follow(key) {
    if (this.followers.has(key)) return;
    const task = background(this.ctx, 'dsh-im follow ' + key, async signal => {
      for (let attempt = 0; !signal.aborted; attempt++) {
        const row = this.conversations.get(key);
        if (!row?.pending?.length) return;
        const idle = new AbortController();
        let timer;
        const touch = () => {clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('Session follow was idle')), FOLLOW_IDLE_MS);};
        try {
          touch();
          let reply = '';
          const consumed = new Set();
          for await (const frame of this.ctx.sessionController.follow({address: {kind: 'session', sessionId: row.sessionId}}, AbortSignal.any([signal, idle.signal]))) {
            touch();
            const events = frame?.type === 'snapshot' ? (frame.records ?? []).map(entry => entry.event) : frame?.type === 'event' ? [frame.event] : [];
            for (const event of events) {
              const current = this.conversations.get(key);
              if (!current || current.sessionId !== row.sessionId) return;
              if (!event || event.seq <= current.delivered) continue;
              if (event.type === 'turn/start') {reply = ''; consumed.clear();}
              else if (event.type === 'user/message') {
                // Native message ids differ from RPC ids. Keep requests pending
                // through turn/end so a restart during generation resumes delivery.
                const id = event.data?.source?.rpcId ?? event.data?.id;
                if (current.pending.includes(id)) consumed.add(id);
              } else if (event.type === 'assistant/message') {
                const text = textOf(event.data?.message);
                if (text) reply = text;
              } else if (event.type === 'turn/end') {
                const reason = event.data?.reason;
                const text = reply || (reason && reason !== 'completed' && reason !== 'end_turn' ? `（本轮未完成：${reason}）` : '');
                if (text && consumed.size) await this.send(current.channel, current.target, text);
                const next = await this.conversations.update(key, value => ({...value, delivered: event.seq, pending: value.pending.filter(id => !consumed.has(id))}));
                reply = '';
                if (!next.pending.length) return;
              }
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          console.warn(`dsh-im follow ${key}: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(Math.min(30_000, 1000 * 2 ** attempt), signal);
        } finally {clearTimeout(timer);}
      }
    });
    this.followers.set(key, task);
    void task.pending.finally(() => {
      if (this.followers.get(key) !== task) return;
      this.followers.delete(key);
      // A new prompt can arrive between the final cursor write and cleanup.
      if (!this.closed && this.conversations.get(key)?.pending?.length) this.follow(key);
    });
  }
}

// The bundle's own service: sibling entries inject it, the Host does not provide it.
export const name = 'dsh-im-core';
export const provide = 'im';
export const inject = ['sessionController', 'storageDomain'];
export const Config = Schema.object({
  agentPreset: Schema.string().description('Agent preset for new conversations; the environment default when empty.'),
  titlePrefix: Schema.boolean().default(true).description('Label automatic titles of new Sessions with their channel.'),
});
export function apply(ctx, config) {
  ctx.provide('im', new ImBridge(ctx, config));
}
