import Schema from '@deepseek-ai/schemastery';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES, MAX_ATTACHMENTS, fileName, imageType} from './media.js';
import {background, chunks, requestId, sleep} from './shared.js';
import {captureContextEnhancementSource, enhanceContextContent, withSentAt} from './reference/context-enhancement.mjs';

const record = {parse: value => value};
const DOMAIN = {name: 'im_core', version: 1, tables: {conversations: {valueSchema: record}, seen: {valueSchema: record}, deliveries: {valueSchema: record}}};
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

/** Text of a message's text blocks. */
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
    this.activities = new Map();
    this.inbound = new Map();
    this.fileSends = new Map();
    this.closed = false;
    ctx.effect(() => () => {this.closed = true;}, 'dsh-im bridge lifetime');
    this.ready = ctx.storageDomain.open(DOMAIN).then(domain => {
      ctx.effect(() => () => domain.close(), 'dsh-im storage');
      this.conversations = domain.table('conversations');
      this.seen = domain.table('seen');
      this.deliveries = domain.table('deliveries');
      ctx.effect(() => ctx.weftSessionEvents.onTurnEnded(event => this.turnEnded(event)), 'dsh-im turn notifications');
      // Replies interrupted by a restart are delivered from their durable cursor.
      for (const [key, row] of this.conversations.entries()) if (row.pending?.length || (row.notified ?? -1) > row.delivered) this.follow(key);
      // Bindings from before turn notifications start syncing at their first notified turn.
      for (const [key, row] of this.conversations.entries()) if (!row.watched) void this.watch(key, row.sessionId);
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
    void this.ready.then(() => {
      if (this.closed || this.channels.get(name) !== channel) return;
      for (const [key, row] of this.conversations.entries()) if (row.channel === name && row.pending?.length) this.startActivity(key);
    });
    return () => {if (this.channels.get(name) === channel) this.channels.delete(name);};
  }

  async send(name, target, text) {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`IM channel ${name} is not active`);
    for (const part of chunks(text, channel.maxChars ?? 2000)) await channel.send(target, part);
  }

  /** Only the authenticated calling Session can address its bound chat. */
  async sendFile(args, exec) {
    await this.ready;
    const sessionId = this.ctx.sessionController.callerSessionId();
    const key = `${sessionId}:${exec.callId}`;
    if (this.fileSends.has(key)) return this.fileSends.get(key);
    const work = this.sendFileOnce(args, exec, sessionId);
    this.fileSends.set(key, work);
    try {return await work;} finally {if (this.fileSends.get(key) === work) this.fileSends.delete(key);}
  }

  async sendFileOnce(args, exec, sessionId) {
    const entry = [...this.conversations.entries()].find(([, row]) => row.sessionId === sessionId);
    if (!entry) throw new Error('当前会话没有绑定 IM 聊天。');
    const [, row] = entry, channel = this.channels.get(row.channel);
    if (!channel?.sendFile) throw new Error('当前渠道不支持文件回传。');
    const deliveryId = `${sessionId}:${exec.callId}`;
    const previous = this.deliveries.get(deliveryId);
    if (previous?.status === 'sent') return {status: 'sent', name: previous.name};
    if (previous) throw new Error('此前投递结果不确定，请先在聊天中确认，避免重复发送。');
    if (!args.path.startsWith('/')) throw new Error('请使用文件的绝对路径。');
    const target = await this.ctx.fs.resolve(args.path);
    const info = await this.ctx.fs.stat(target, exec.signal);
    if (!info || info.type !== 'file' || info.size > MAX_ATTACHMENT_BYTES) throw new Error('仅支持不超过 10 MiB 的文件。');
    const data = await this.ctx.fs.readBytes(target, exec.signal, MAX_ATTACHMENT_BYTES);
    const name = fileName(args.name || args.path);
    const image = args.asImage === true && !!imageType(data);
    if (args.asImage && !image) throw new Error('该文件不是支持的图片格式。');
    exec.signal.throwIfAborted();
    // Reserve before the first provider call. An uncertain send is never repeated automatically.
    await this.deliveries.put(deliveryId, {status: 'sending', name, at: Date.now()});
    await channel.sendFile(row.target, {data, name, image, signal: exec.signal, deliveryId: await requestId(deliveryId)});
    await this.deliveries.put(deliveryId, {status: 'sent', name, at: Date.now()});
    return {status: 'sent', name};
  }

  async startActivity(key) {
    if (this.activities.has(key)) return;
    const task = background(this.ctx, 'dsh-im activity ' + key, async signal => {
      try {
        while (!signal.aborted) {
          const row = this.conversations.get(key), channel = this.channels.get(row?.channel);
          if (!row?.pending?.length || !channel?.typing) return;
          try {await channel.typing(row.target, true);} catch { /* Input status must not block the answer. */ }
          await sleep(channel.typingInterval ?? 8000, signal);
        }
      } finally {
        const row = this.conversations.get(key);
        try {if (row) await this.channels.get(row.channel)?.typing?.(row.target, false);} catch { /* The provider expires stale indicators. */ }
      }
    });
    this.activities.set(key, task);
    void task.pending.finally(() => {if (this.activities.get(key) === task) this.activities.delete(key);});
  }

  async stopActivity(key) {
    const task = this.activities.get(key); task?.abort(); await task?.pending;
  }

  async updateCard(key, text, final = false) {
    let row = this.conversations.get(key);
    const channel = this.channels.get(row?.channel);
    if (!row || !channel?.startReply) return false;
    const sessionId = row.sessionId;
    const owns = () => this.conversations.get(key)?.sessionId === sessionId;
    try {
      if (!row.card && !row.cardFailed) {
        const card = await channel.startReply(row.target, await requestId(row.sessionId + ':' + row.pending.join(',')));
        if (!owns()) return false;
        row = await this.conversations.update(key, current => current.sessionId === sessionId ? {...current, card} : current);
      }
      if (!owns() || !row.card || row.cardFailed) return false;
      await channel.updateReply(row.card, text, final);
      if (!owns()) return false;
      await this.conversations.update(key, current => current.sessionId === sessionId ? {...current, card: row.card} : current);
      return owns();
    } catch {
      if (owns()) await this.conversations.update(key, current => current.sessionId === sessionId ? {...current, cardFailed: true} : current);
      return false;
    }
  }

  async catalog() {return this.ctx.sessionController.modelCatalog({});}

  /** Forget one bot's routes before removing its credentials. */
  async clear(channel) {
    await this.ready;
    for (const [key, row] of this.conversations.entries()) if (row.channel === channel) {
      this.followers.get(key)?.abort();
      this.followers.delete(key);
      await this.stopActivity(key);
      await this.conversations.delete(key);
      await this.ctx.weftSessionEvents.unwatch(row.sessionId).catch(() => {});
    }
    for (const key of this.seen.keys()) if (key.startsWith(channel + ':')) await this.seen.delete(key);
  }

  /**
   * Accept one inbound message. Redeliveries of the same channel message are ignored.
   * @param {{channel: string, conversation: string, title?: string, sender: string, senderName?: string, text: string, messageId: string, target: unknown, group?: boolean}} message
   * @returns {Promise<'accepted' | 'duplicate' | 'denied' | 'command' | 'failed'>}
   */
  async receive(message) {
    const key = `${message.channel}:${message.conversation}`;
    const work = (this.inbound.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.accept(message));
    this.inbound.set(key, work);
    try {return await work;} finally {if (this.inbound.get(key) === work) this.inbound.delete(key);}
  }

  async accept(message) {
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
      await this.stopActivity(key);
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
      await this.stopActivity(key);
      if (row?.card) await this.updateCard(key, '已开始新会话。', true);
      const previous = row?.sessionId;
      row = {sessionId: created.sessionId, delivered: -1, pending: [], target: message.target, channel: message.channel, group: !!message.group, titlePrefix: this.config.titlePrefix !== false, syncFrom: 0};
      await this.conversations.put(key, row);
      await this.watch(key, created.sessionId);
      if (previous) await this.ctx.weftSessionEvents.unwatch(previous).catch(() => {});
      if (command === 'new') {
        await this.send(message.channel, message.target, '已开始新会话。');
        return 'command';
      }
    }
    const stableId = await requestId(seenKey);
    // Durable native prompt provenance lets the Host decorate automatic titles
    // without pinning an opaque sender id as an explicit user rename.
    const id = row.titlePrefix ? `${message.channel}-${stableId}` : stableId;
    row = await this.conversations.update(key, current => ({...current, target: message.target, group: !!message.group, pending: [...new Set([...(current.pending ?? []), id])].slice(-32)}));
    const body = command === 'steer' ? text.replace(/^\/steer\b\s*/i, '') : text;
    const content = message.group && message.senderName ? `${message.senderName}：${body}` : body;
    const captured = captureContextEnhancementSource({botId: channel.botId?.(), getSettings: () => channel.contextEnhancement}, message.group ? 'group' : 'direct', withSentAt(() => ({
      channel: message.channel, senderId: message.sender, senderName: message.senderName,
      conversationTitle: message.title, chatId: message.chatId ?? message.conversation, threadId: message.threadId,
    }), message.sentAt));
    const mode = command === 'steer' || channel.busyMessageMode === 'steer' && channel.access?.(message, true)?.allowed !== false ? 'steer' : 'queue';
    try {
      const attachments = message.attachments ?? [], parts = [];
      if (attachments.length > MAX_ATTACHMENTS) throw new Error('每条消息最多 10 个附件。');
      let total = 0;
      for (const attachment of attachments) {
        const data = await attachment.load();
        total += data.byteLength;
        if (data.byteLength > MAX_ATTACHMENT_BYTES || total > MAX_MESSAGE_BYTES) throw new Error('单个附件最多 10 MiB，每条消息合计最多 20 MiB。');
        const uploaded = await this.ctx.sessionController.uploadAttachment(row.sessionId, {name: fileName(attachment.name), image: !!attachment.image, mediaType: imageType(data) ?? ''}, data);
        parts.push({type: 'file', receiptId: uploaded.file.receiptId});
        if (uploaded.image) parts.push(uploaded.image);
        if (uploaded.imageError) parts.push({type: 'text', text: uploaded.imageError});
      }
      const prompt = enhanceContextContent(content || (parts.length ? '请查看附件。' : ''), captured);
      this.startActivity(key);
      await this.ctx.sessionController.prompt({sessionId: row.sessionId, requestId: id, mode, content: [{type: 'text', text: prompt}, ...parts]});
    } catch (error) {
      await this.conversations.update(key, current => ({...current, pending: current.pending.filter(value => value !== id)}));
      if (!this.conversations.get(key).pending.length) await this.stopActivity(key);
      await this.seen.delete(seenKey);
      await this.send(message.channel, message.target, `消息接入失败：${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
    this.follow(key);
    return 'accepted';
  }

  /** Subscribe to the bound Session's turn ends; a failure retries at the next activation. */
  async watch(key, sessionId) {
    try {
      await this.ctx.weftSessionEvents.watch(sessionId);
      await this.conversations.update(key, current => current?.sessionId === sessionId ? {...current, watched: true} : current);
    } catch (error) {console.warn(`dsh-im watch ${key}: ${error instanceof Error ? error.message : String(error)}`);}
  }

  /** A hint only: the cursor decides what is delivered, so repeats and losses are harmless. */
  async turnEnded({sessionId, seq}) {
    await this.ready;
    for (const [key, row] of [...this.conversations.entries()]) {
      if (row.sessionId !== sessionId || seq <= row.delivered) continue;
      await this.conversations.update(key, current => current?.sessionId !== sessionId ? current
        : {...current, notified: Math.max(current.notified ?? -1, seq), syncFrom: current.syncFrom ?? seq});
      this.follow(key);
    }
  }

  /**
   * Whether a turn the chat did not start is sent there: schedule results go to
   * every chat unless sync is off; other turns only to private chats with full sync.
   */
  mirrored(row, messages, seq) {
    if (!messages.length || row.syncFrom === undefined || seq < row.syncFrom) return undefined;
    const mode = this.channels.get(row.channel)?.sessionSync ?? 'scheduled';
    if (mode === 'off') return undefined;
    if (messages.some(data => data?.source?.kind === 'schedule')) return 'schedule';
    return mode === 'all' && row.group === false ? 'web' : undefined;
  }

  /** Deliver each finished turn of a conversation's Session once, from its durable cursor. */
  follow(key) {
    if (this.followers.has(key)) return;
    const task = background(this.ctx, 'dsh-im follow ' + key, async signal => {
      for (let attempt = 0; !signal.aborted; attempt++) {
        const row = this.conversations.get(key);
        if (!row?.pending?.length && !((row?.notified ?? -1) > row?.delivered)) return;
        const idle = new AbortController();
        let timer;
        const touch = () => {clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('Session follow was idle')), FOLLOW_IDLE_MS);};
        try {
          touch();
          let reply = '', draft = '', attemptId, lastCardUpdate = 0;
          this.startActivity(key);
          const consumed = new Set(), foreign = [];
          for await (const frame of this.ctx.sessionController.follow({address: {kind: 'session', sessionId: row.sessionId}, assistantStream: true}, AbortSignal.any([signal, idle.signal]))) {
            touch();
            if (frame?.type === 'assistant-stream' && consumed.size) {
              const live = frame.frame;
              if (live.type === 'start') {draft = ''; attemptId = live.attemptId;}
              else if (live.type === 'chunk' && live.attemptId === attemptId && live.chunk?.type === 'text-delta') {
                draft += live.chunk.text;
                if (Date.now() - lastCardUpdate >= 800) {await this.updateCard(key, draft); lastCardUpdate = Date.now();}
              } else if (live.type === 'end' && live.outcome?.kind === 'abandoned') {draft = ''; await this.updateCard(key, '正在重新生成…');}
            }
            const events = frame?.type === 'snapshot' ? (frame.records ?? []).map(entry => entry.event) : frame?.type === 'event' ? [frame.event] : [];
            for (const event of events) {
              const current = this.conversations.get(key);
              if (!current || current.sessionId !== row.sessionId) return;
              if (!event || event.seq <= current.delivered) continue;
              if (event.type === 'turn/start') {reply = ''; consumed.clear(); foreign.length = 0;}
              else if (event.type === 'user/message') {
                // Native message ids differ from RPC ids. Keep requests pending
                // through turn/end so a restart during generation resumes delivery.
                const id = event.data?.source?.rpcId ?? event.data?.id;
                if (current.pending.includes(id)) {consumed.add(id); if (frame.type !== 'snapshot') await this.updateCard(key, '正在思考…');} else foreign.push(event.data);
              } else if (event.type === 'assistant/message') {
                const text = textOf(event.data?.message);
                if (text) {reply = text; if (consumed.size && frame.type !== 'snapshot') await this.updateCard(key, text);}
              } else if (event.type === 'turn/end') {
                const reason = event.data?.reason;
                const text = reply || (reason && reason !== 'completed' && reason !== 'end_turn' ? `（本轮未完成：${reason}）` : '');
                const mirror = consumed.size ? undefined : this.mirrored(current, foreign, event.seq);
                if (consumed.size) {
                  const card = await this.updateCard(key, text || '（本轮没有文本回复）', true);
                  if (signal.aborted || this.conversations.get(key)?.sessionId !== row.sessionId) return;
                  if (text && !card) await this.send(current.channel, current.target, text);
                }
                else if (reply && mirror) {
                  const asked = mirror === 'web' ? foreign.map(data => textOf(data)).filter(Boolean).join('\n').slice(0, 500) : '';
                  // Mirrored turns are best effort: a refused send advances the cursor instead of repeating.
                  try {await this.send(current.channel, current.target, asked ? `（Web）${asked}\n\n${reply}` : reply);}
                  catch (error) {console.warn(`dsh-im mirror ${key}: ${error instanceof Error ? error.message : String(error)}`);}
                }
                const next = await this.conversations.update(key, value => ({...value, delivered: event.seq, pending: value.pending.filter(id => !consumed.has(id)), card: undefined, cardFailed: undefined}));
                reply = '';
                if (!next.pending.length) await this.stopActivity(key);
                if (!next.pending.length && !((next.notified ?? -1) > next.delivered)) return;
              }
            }
            if (frame?.type === 'snapshot' && consumed.size && frame.assistantStream?.activeAttempt) {
              const active = frame.assistantStream.activeAttempt;
              attemptId = active.attemptId;
              draft = active.stream.filter(chunk => chunk?.type === 'text-delta').map(chunk => chunk.text).join('');
              if (draft) {await this.updateCard(key, draft); lastCardUpdate = Date.now();}
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
      // A new prompt or notification can arrive between the final cursor write and cleanup.
      const row = this.conversations.get(key);
      if (!this.closed && (row?.pending?.length || (row?.notified ?? -1) > row?.delivered)) this.follow(key);
    });
  }
}

// The bundle's own service: sibling entries inject it, the Host does not provide it.
export const name = 'dsh-im-core';
export const provide = 'im';
export const inject = ['sessionController', 'storageDomain', 'weftSessionEvents', 'fs', 'tools'];
export const Config = Schema.object({
  agentPreset: Schema.string().description('Agent preset for new conversations; the environment default when empty.'),
  titlePrefix: Schema.boolean().default(true).description('Label automatic titles of new Sessions with their channel.'),
});
export function apply(ctx, config) {
  const bridge = new ImBridge(ctx, config);
  ctx.provide('im', bridge);
  ctx.tools.register(defineTool({name: 'im_send_file', description: 'Send a real workspace file to the IM chat bound to this Session. Use asImage for a supported raster image. Use an absolute path. Maximum 10 MiB. Do not retry uncertain deliveries.',
    parameters: {path: {type: 'string', required: true}, name: {type: 'string'}, asImage: {type: 'boolean'}},
    output: {schema: {type: 'json'}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
    execute: (args, exec) => bridge.sendFile(args, exec),
  }));
}
