import Schema from '@deepseek-ai/schemastery';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES, MAX_ATTACHMENTS, fileName, imageType} from './media.js';
import {background, chunks, requestId, sleep} from './shared.js';
import {captureContextEnhancementSource, enhanceContextContent, withSentAt} from './reference/context-enhancement.mjs';
import {ImQuestions} from './questions.js';

const record = {parse: value => value};
const DOMAIN = {name: 'im_core', version: 3, compatibleVersions: [1, 2], tables: {questions: {valueSchema: record}, session_routes: {valueSchema: record}, task_routes: {valueSchema: record}, conversations: {valueSchema: record}, seen: {valueSchema: record}, deliveries: {valueSchema: record}}};
const SEEN_LIMIT = 2000;
/** A follow stream without frames is reopened, so a missed boundary cannot pin a stream forever. */
const FOLLOW_IDLE_MS = 600_000;

const HELP = [
  '可用命令：',
  '/new 开始一个新会话',
  '/stop 停止当前回复',
  '/automations 查看本聊天的自动化通知',
  '/notify <任务 ID> 将任务通知绑定到本聊天',
  '/notify <任务 ID> off 关闭本聊天的该任务通知',
  '/steer <内容> 向当前任务补充指令',
  '/questions 查看等待你回答的问题',
  '/answer <提问编号> <答案> 回答指定问题',
  '/help 显示本帮助',
].join('\n');

/** Text of a message's text blocks. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').trim();
}

/** Only trusted schedule provenance can select a notification route. */
function scheduleIds(message) {
  if (message?.source?.kind !== 'schedule') return [];
  const text = textOf(message);
  try {
    if (text.startsWith('[SCHEDULE REMINDER]\n')) {
      const line = text.split('\n').find(line => line.startsWith('schedule_id_json: '));
      const id = JSON.parse(line?.slice('schedule_id_json: '.length));
      return typeof id === 'string' ? [id] : [];
    }
    if (text.startsWith('[SCHEDULE REMINDER BATCH]\n')) {
      const line = text.split('\n').find(line => line.startsWith('reminders_json: '));
      const reminders = JSON.parse(line?.slice('reminders_json: '.length));
      return Array.isArray(reminders) ? reminders.flatMap(row => typeof row.schedule_id === 'string' ? [row.schedule_id] : []) : [];
    }
  } catch { /* Unknown framing is not a notification. */ }
  return [];
}

/**
 * The shared IM bridge: one Harness Session per channel conversation, prompts
 * deduplicated by channel message id, and each finished turn delivered back
 * through the channel that owns the conversation.
 *
 * Each bot registers with `ctx.im.channel(bot, {kind, send, maxChars, allows})`
 * under its local key and hands inbound messages to `ctx.im.receive(...)` with
 * that key as `channel`; conversations are keyed by bot, so two bots of one
 * channel never share a Session.
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
    this.ready = ctx.storageDomain.open(DOMAIN).then(async domain => {
      ctx.effect(() => () => domain.close(), 'dsh-im storage');
      this.conversations = domain.table('conversations');
      this.taskRoutes = domain.table('task_routes');
      this.sessionRoutes = domain.table('session_routes');
      this.seen = domain.table('seen');
      this.deliveries = domain.table('deliveries');
      this.questions = new ImQuestions(this, domain.table('questions'));
      ctx.effect(() => ctx.weftSessionEvents.onTurnEnded(event => this.turnEnded(event)), 'dsh-im turn notifications');
      if(this.questions.enabled&&typeof ctx.weftSessionEvents.onQuestionChanged==='function')ctx.effect(() => ctx.weftSessionEvents.onQuestionChanged(({sessionId}) => this.questions.sync(sessionId)), 'dsh-im question notifications');
      for (const [chatKey, row] of this.conversations.entries()) if (!row.automation && !this.sessionRoutes.get(row.sessionId)) await this.sessionRoutes.put(row.sessionId, {chatKey, channel: row.channel, target: row.target, group: row.group});
      queueMicrotask(() => {void this.ready.then(() => this.refreshRoutes()).catch(error => console.warn('dsh-im automation routes:', String(error)));});
      // Replies interrupted by a restart are delivered from their durable cursor.
      for (const [key, row] of this.conversations.entries()) if (row.pending?.length || (row.notified ?? -1) > row.delivered) this.follow(key);
      // Bindings from before turn notifications start syncing at their first notified turn.
      for (const [key, row] of this.conversations.entries()) void this.watch(key, row.sessionId);
      queueMicrotask(() => {void this.ready.then(async () => {for (const sessionId of new Set([...this.conversations.entries()].map(([, row]) => row.sessionId))) await this.questions.sync(sessionId);}).catch(error => console.warn('dsh-im question recovery:', String(error)));});
    });
    void this.ready.catch(() => {});
  }

  /**
   * Register one bot's transport for this plugin's lifetime.
   * @param {string} name - the bot's local key: its channel, such as `feishu`, or `<channel>_<hex>` for an added bot.
   * @param {{kind: string, send(target: unknown, text: string): Promise<void>, maxChars?: number, allows?(sender: string): boolean}} channel - `kind` is the channel the bot belongs to.
   */
  channel(name, channel) {
    if (this.channels.has(name)) throw new Error(`IM bot ${name} is registered twice`);
    this.channels.set(name, channel);
    void this.ready.then(() => {
      if (this.closed || this.channels.get(name) !== channel) return;
      for (const [key, row] of this.conversations.entries()) if (row.channel === name && row.pending?.length) this.startActivity(key);
      for (const sessionId of new Set([...this.conversations.entries()].filter(([,row])=>row.channel===name).map(([,row])=>row.sessionId))) void this.questions.sync(sessionId).catch(()=>{});
    });
    return () => {if (this.channels.get(name) === channel) this.channels.delete(name);};
  }

  async send(name, target, text, deliveryId) {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`IM channel ${name} is not active`);
    let index = 0; const receipts=[];
    for (const part of chunks(text, channel.maxChars ?? 2000)) {const result=await channel.send(target, part, deliveryId ? {deliveryId: `${deliveryId}:${index++}`} : undefined);if(typeof result?.messageId==='string')receipts.push(result.messageId);}
    return receipts;
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
    const destinations = new Map([...this.conversations.entries()].filter(([, row]) => row.sessionId === sessionId).map(([key, row]) => [row.chatKey ?? key, row]));
    if (destinations.size > 1) throw new Error('此执行会话绑定了不同聊天，无法确定文件收件人。请为不同聊天选择不同执行会话。');
    const row = [...destinations.values()][0];
    if (!row) throw new Error('当前会话没有绑定 IM 聊天。');
    const channel = this.channels.get(row.channel);
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
    if (this.activities.has(key) || this.questions?.waiting(key)) return;
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
  isQuestionReply(channel,conversation,sender,replyTo) {return !!replyTo&&this.questions?.matches(`${channel}:${conversation}`,sender,replyTo);}

  /** Forget one bot's routes before removing its credentials. */
  async clear(channel) {
    await this.ready;
    await this.questions.clear(channel);
    for (const [key, row] of this.conversations.entries()) if (row.channel === channel) {
      this.followers.get(key)?.abort();
      this.followers.delete(key);
      await this.stopActivity(key);
      await this.conversations.delete(key);
      await this.ctx.weftSessionEvents.unwatch(row.sessionId).catch(() => {});
    }
    for (const [sessionId, route] of this.sessionRoutes.entries()) if (route.channel === channel) {await this.sessionRoutes.delete(sessionId); await this.ctx.weftSessionEvents.unwatch(sessionId).catch(() => {});}
    for (const [id, route] of this.taskRoutes.entries()) if (route.channel === channel) await this.taskRoutes.delete(id);
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
    const command = /^\/(new|stop|help|steer|automations|notify|answer|questions)\b/i.exec(text)?.[1]?.toLowerCase();
    const access = channel.access?.(message, !!command && !['answer','questions'].includes(command));
    if (access?.allowed === false || channel.allows && !channel.allows(message.sender)) {
      await this.send(message.channel, message.target, access?.reason === 'command-not-allowed' ? '你可以与机器人对话，但没有执行命令的权限。' : `尚未授权与此机器人对话。你的 ID：${message.sender}\n请管理员在插件设置中把它加入允许列表。`);
      return 'denied';
    }
    const key = `${message.channel}:${message.conversation}`;
    if (!['new','stop','help','steer','automations','notify'].includes(command)) {
      try {if(await this.questions.receive(message))return 'command';}
      catch(error){await this.seen.delete(seenKey);throw error;}
    }
    if (command === 'steer' && !text.replace(/^\/steer\b\s*/i, '').trim()) {
      await this.send(message.channel, message.target, '用法：/steer <补充内容>'); return 'command';
    }
    if (command === 'automations' || command === 'notify') {
      const tasks = await this.refreshRoutes();
      if (command === 'automations') {
        const bound = tasks.filter(task => this.taskRoutes.get(task.id)?.chatKey === key && !this.taskRoutes.get(task.id)?.disabled);
        await this.send(message.channel, message.target, bound.length ? bound.map(task => `${task.title || task.id}\n${task.id} · ${task.status}\n执行会话：${task.target.sessionId || '待创建'}`).join('\n\n') : '本聊天尚未绑定自动化通知。用 /notify <任务 ID> 绑定已有任务。');
      } else {
        const match = /^\/notify\s+(\S+)(?:\s+(off))?\s*$/i.exec(text);
        const task = match && tasks.find(task => task.id === match[1]);
        if (!task) {await this.send(message.channel, message.target, '请使用 /notify <任务 ID> [off]；任务必须属于当前环境。'); return 'command';}
        const previous = this.taskRoutes.get(task.id);
        if (match[2] && previous?.chatKey !== key) {await this.send(message.channel, message.target, '该任务没有向本聊天发送通知。'); return 'command';}
        await this.taskRoutes.put(task.id, {chatKey: key, channel: message.channel, target: message.target, group: !!message.group, disabled: !!match[2]});
        await this.refreshRoutes();
        await this.send(message.channel, message.target, match[2] ? '已关闭该任务的 IM 通知；自动化继续执行。' : '已将该任务通知绑定到本聊天；更换执行会话不会改变通知目标。');
      }
      return 'command';
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
        created = await this.ctx.sessionController.create({cwd: channel.workspace || '/workspace', ...(preset ? {agentPreset: preset} : {}), ...(channel.permissionPreset ? {permissionPreset: channel.permissionPreset} : {})});
        if (channel.modelSelection) await this.ctx.sessionController.selectModel({sessionId: created.sessionId, ...channel.modelSelection});
      } catch {
        await this.send(message.channel, message.target, '无法创建新会话，请管理员检查工作区、Agent Preset、权限模式、模型与思考强度设置。已有会话保持可用。');
        return 'failed';
      }
      this.followers.get(key)?.abort();
      this.followers.delete(key);
      await this.stopActivity(key);
      if (row?.card) await this.updateCard(key, '已开始新会话。', true);
      await this.refreshRoutes();
      const previous = row?.sessionId;
      row = {sessionId: created.sessionId, delivered: -1, pending: [], target: message.target, channel: message.channel, group: !!message.group, titlePrefix: this.config.titlePrefix !== false, syncFrom: 0};
      await this.sessionRoutes.put(created.sessionId, {chatKey: key, channel: row.channel, target: row.target, group: row.group});
      await this.conversations.put(key, row);
      await this.watch(key, created.sessionId);
      if (previous && !this.sessionRoutes.get(previous) && ![...this.conversations.entries()].some(([, route]) => route.sessionId === previous)) await this.ctx.weftSessionEvents.unwatch(previous).catch(() => {});
      if (command === 'new') {
        await this.send(message.channel, message.target, '已开始新会话。');
        return 'command';
      }
    }
    for (const [sessionId, route] of this.sessionRoutes.entries()) if (route.chatKey === key) await this.sessionRoutes.put(sessionId, {...route, target: message.target, group: !!message.group});
    for (const [id, route] of this.taskRoutes.entries()) if (route.chatKey === key) await this.taskRoutes.put(id, {...route, target: message.target, group: !!message.group});
    const stableId = await requestId(seenKey);
    // Durable native prompt provenance lets the Host decorate automatic titles
    // without pinning an opaque sender id as an explicit user rename.
    const id = row.titlePrefix ? `${channel.kind}-${stableId}` : stableId;
    row = await this.conversations.update(key, current => ({...current, target: message.target, group: !!message.group, pending: [...new Set([...(current.pending ?? []), id])].slice(-32), recent: [...new Set([...(current.recent ?? []), id])].slice(-64),
      origins:Object.fromEntries([...Object.entries(current.origins??{}),[id,{sender:message.sender,target:message.target,group:!!message.group}]].slice(-64))}));
    const body = command === 'steer' ? text.replace(/^\/steer\b\s*/i, '') : text;
    const content = message.group && message.senderName ? `${message.senderName}：${body}` : body;
    const captured = captureContextEnhancementSource({botId: channel.botId?.(), getSettings: () => channel.contextEnhancement}, message.group ? 'group' : 'direct', withSentAt(() => ({
      channel: channel.kind, senderId: message.sender, senderName: message.senderName,
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

  /** Task routes survive /new and retargeting; only explicit /notify changes their destination. */
  async refreshRoutes() {
    // Serialize read/modify/write against concurrent prompts and turn notifications.
    const work = (this.routeRefresh ?? Promise.resolve()).catch(() => {}).then(() => this.refreshRoutesOnce());
    this.routeRefresh = work;
    return work;
  }

  async refreshRoutesOnce() {
    const tasks = await this.ctx.sessionController.scheduleCatalog({});
    for (const task of tasks) {
      if (this.taskRoutes.get(task.id)) continue;
      for (const sessionId of task.involvedSessionIds ?? []) {
        const route = this.sessionRoutes.get(sessionId);
        if (!route) continue;
        await this.taskRoutes.put(task.id, {...route});
        break;
      }
    }
    const wanted = new Map();
    for (const task of tasks) {
      const route = this.taskRoutes.get(task.id), sessionId = task.target.sessionId;
      if (!route || route.disabled || !sessionId) continue;
      const key = `automation:${JSON.stringify([route.chatKey, sessionId])}`;
      const current = wanted.get(key);
      wanted.set(key, {...route, sessionId, taskIds: [...(current?.taskIds ?? []), task.id]});
    }
    for (const [key, route] of wanted) {
      const current = this.conversations.get(key);
      // New bindings begin at their first notification, without replaying old turns.
      await this.conversations.put(key, {...(current ?? {delivered: -1, pending: []}), ...route, automation: true});
      if (!current?.watched) await this.watch(key, route.sessionId);
    }
    const removed = new Set();
    for (const [key, row] of [...this.conversations.entries()]) if (row.automation && !wanted.has(key)) {
      this.followers.get(key)?.abort(); this.followers.delete(key);
      await this.conversations.delete(key); removed.add(row.sessionId);
    }
    for (const sessionId of removed) if (!this.sessionRoutes.get(sessionId) && ![...this.conversations.entries()].some(([, row]) => row.sessionId === sessionId)) await this.ctx.weftSessionEvents.unwatch(sessionId);
    const ids = new Set(tasks.map(task => task.id));
    for (const [id] of this.taskRoutes.entries()) if (!ids.has(id)) await this.taskRoutes.delete(id);
    return tasks;
  }

  /** Subscribe to the bound Session's turn ends; a failure retries at the next activation. */
  async watch(key, sessionId) {
    try {
      if(this.questions.enabled&&typeof this.ctx.weftSessionEvents.watchQuestions==='function')await this.ctx.weftSessionEvents.watchQuestions(sessionId);
      else await this.ctx.weftSessionEvents.watch(sessionId);
      await this.conversations.update(key, current => current?.sessionId === sessionId ? {...current, watched: true} : current);
    } catch (error) {console.warn(`dsh-im watch ${key}: ${error instanceof Error ? error.message : String(error)}`);}
  }

  /** A hint only: the cursor decides what is delivered, so repeats and losses are harmless. */
  async turnEnded({sessionId, seq}) {
    await this.ready;
    await this.questions.sync(sessionId).catch(error=>console.warn('dsh-im question state:',String(error)));
    await this.refreshRoutes();
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
    const ids = messages.flatMap(scheduleIds);
    if (row.automation) {
      const chat = this.conversations.get(row.chatKey);
      const users = messages.filter(message => message.source?.kind === 'user');
      if (users.length) {
        if (chat?.sessionId === row.sessionId && users.every(message => chat.recent?.includes(message.source.rpcId))) return undefined;
        if (ids.some(id => row.taskIds.includes(id))) return 'mixed';
      }
      if (!ids.some(id => row.taskIds.includes(id))) return undefined;
      // A shared execution can batch several tasks into one answer. Never copy
      // another chat's task result into this chat.
      return ids.every(id => {const route = this.taskRoutes.get(id); return route && !route.disabled && route.chatKey === row.chatKey;}) ? 'schedule' : 'mixed';
    }
    // Task notifications have their own cursor and destination.
    if (messages.some(data => data?.source?.kind === 'schedule')) return undefined;
    return mode === 'all' && row.group === false ? 'web' : undefined;
  }

  conflicts(key, messages) {
    return messages.flatMap(scheduleIds).some(id => {const route = this.taskRoutes.get(id); return !route || route.disabled || route.chatKey !== key;});
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
                if (!this.conflicts(key, foreign) && Date.now() - lastCardUpdate >= 800) {await this.updateCard(key, draft); lastCardUpdate = Date.now();}
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
                const id = event.data?.source?.kind==='user-question-reply'?`question:${event.data.source.callId}`:event.data?.source?.rpcId ?? event.data?.id;
                if (current.pending.includes(id)) {consumed.add(id); if (frame.type !== 'snapshot') await this.updateCard(key, '正在思考…');} else foreign.push(event.data);
              } else if (event.type === 'assistant/message') {
                const text = textOf(event.data?.message);
                if (text) {reply = text; if (consumed.size && frame.type !== 'snapshot' && !this.conflicts(key, foreign)) await this.updateCard(key, text);}
              } else if (event.type === 'turn/end') {
                const reason = event.data?.reason;
                const text = consumed.size && this.conflicts(key, foreign) ? '本轮包含其他聊天或未启用通知的自动化，结果未转发。请分开执行会话后重试。' : reply || (reason && reason !== 'completed' && reason !== 'end_turn' ? `（本轮未完成：${reason}）` : '');
                const mirror = consumed.size ? undefined : this.mirrored(current, foreign, event.seq);
                if (consumed.size) {
                  const card = await this.updateCard(key, text || '（本轮没有文本回复）', true);
                  if (signal.aborted || this.conversations.get(key)?.sessionId !== row.sessionId) return;
                  if (text && !card) await this.send(current.channel, current.target, text, `${row.sessionId}:${event.seq}`);
                }
                else if (reply && mirror) {
                  const asked = mirror === 'web' ? foreign.map(data => textOf(data)).filter(Boolean).join('\n').slice(0, 500) : '';
                  // Mirrored turns are best effort: a refused send advances the cursor instead of repeating.
                  try {await this.send(current.channel, current.target, mirror === 'mixed' ? '本次自动化回答混合了其他对话或未启用通知的任务，结果未转发。请分开执行会话，再单独运行。' : asked ? `（Web）${asked}\n\n${reply}` : reply, `${row.sessionId}:${event.seq}`);}
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
              if (draft && !this.conflicts(key, foreign)) {await this.updateCard(key, draft); lastCardUpdate = Date.now();}
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
  webUrl: Schema.string().default('').description('This environment’s public Weft web address, used only for question links.'),
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
