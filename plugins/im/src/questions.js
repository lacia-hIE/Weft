import {requestId} from './shared.js';

/** Native question answers; this module owns presentation and chat routing, never Agent execution. */
export function parseQuestionAnswer(question, text) {
  const options = question.options ?? [], value = text.trim();
  if (!value) throw new Error('请回复选项编号或填写答案。');
  if (value === '/skip') return {id:question.id,selected:[]};
  if (options.length && /^\d+(?:\s*[,，、]\s*\d+)*$/.test(value)) {
    const indexes = value.split(/[,，、]/).map(part => Number(part.trim()) - 1);
    if (indexes.some(index => index < 0 || index >= options.length) || new Set(indexes).size !== indexes.length || !question.multiSelect && indexes.length > 1)
      throw new Error('请选择有效的选项编号；多选题用逗号分隔。');
    return {id: question.id, selected: indexes.map(index => options[index].label)};
  }
  const option = options.find(option => option.label === value);
  return option ? {id: question.id, selected: [option.label]} : {id: question.id, selected: [], custom: value};
}

export function questionText(row, webUrl) {
  const index = row.answers?.length ?? 0, question = row.questions[index];
  if (!question) return '';
  const lines = [`需要你回答 · ${row.code}${row.questions.length > 1 ? ` · ${index + 1}/${row.questions.length}` : ''}`,
    question.header, question.question, question.detail,
    ...(question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
    question.multiSelect ? '可多选，用逗号分隔编号，也可直接填写答案。' : '回复选项编号或直接填写答案。',
    `回复本消息，或发送 /answer ${row.code} <答案>。发送 /answer ${row.code} /skip 跳过当前题。`,
    row.state === 'continued' ? 'Agent 已继续执行，此问题仍可补答。' : undefined];
  if (webUrl) {
    try {const url = new URL(webUrl); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {url.searchParams.set('weft-session', row.sessionId); lines.push(`在 Weft 回答：${url.href}`);}} catch { /* A missing or invalid configured URL must not block channel replies. */ }
  }
  return lines.filter(Boolean).join('\n\n');
}

export class ImQuestions {
  constructor(bridge, table) {
    this.bridge = bridge; this.table = table; this.syncs = new Map();
    this.enabled=typeof bridge.ctx.sessionController.questions==='function'&&typeof bridge.ctx.sessionController.answerQuestion==='function';
  }
  waiting(chatKey) {return this.enabled&&[...this.table.entries()].some(([,row])=>row.chatKey===chatKey&&!row.closed&&row.available!==false);}
  matches(chatKey,sender,replyTo) {return this.enabled&&[...this.table.entries()].some(([,row])=>row.chatKey===chatKey&&row.sender===sender&&row.receipts?.includes(replyTo));}
  async clear(channel) {for(const [key,row] of this.table.entries())if(row.channel===channel)await this.table.delete(key);}
  sync(sessionId) {
    if(!this.enabled)return Promise.resolve();
    const current=this.syncs.get(sessionId);if(current){current.again=true;return current.pending;}
    const work={again:false,pending:undefined};
    work.pending=Promise.resolve().then(async()=>{do{work.again=false;await this.refresh(sessionId);}while(work.again&&!this.bridge.closed);})
      .finally(()=>{if(this.syncs.get(sessionId)===work)this.syncs.delete(sessionId);});
    this.syncs.set(sessionId,work);return work.pending;
  }
  async page(sessionId) {
    const page = await this.bridge.ctx.sessionController.page({address: {kind: 'session', sessionId}, maxMessages: 200, turnWindow: {minMessages: 1, minTurns: 1}});
    return (page.records ?? []).map(record => record.event);
  }
  /** A question may only go to the one chat whose trusted native prompt started the current turn. */
  route(sessionId, events) {
    const start = events.findLastIndex(event => event.type === 'turn/start');
    if (start < 0) return;
    // DSH logs runtime/time snapshots as user-role messages too. Only actual
    // user RPCs identify the person; generated context cannot select a route.
    const users = events.slice(start).filter(event => event.type === 'user/message' && !['runtime-context','time-context','user-question-reply'].includes(event.data?.source?.kind));
    if (!users.length) return;
    const routes = [...this.bridge.conversations.entries()].filter(([, row]) => row.sessionId === sessionId && !row.automation);
    const matches = routes.flatMap(([chatKey, row]) => {
      const ids = users.map(event => event.data?.source?.rpcId);
      if (!ids.every(id => typeof id === 'string' && row.origins?.[id])) return [];
      const origins = ids.map(id => row.origins[id]), sender = origins[0].sender;
      // A mixed-sender turn must be answered on the Web, where its full context is visible.
      if (!sender || origins.some(origin => origin.sender !== sender)) return [];
      const origin = origins.at(-1);
      return [{chatKey, channel: row.channel, target: origin.target, sender, group: !!origin.group}];
    });
    if (matches.length === 1) return matches[0];
  }
  async refresh(sessionId) {
    const bridge = this.bridge;
    if (bridge.closed) return;
    const pending = await bridge.ctx.sessionController.questions({sessionId});
    const stored = [...this.table.entries()].filter(([, row]) => row.sessionId === sessionId);
    if (!pending.length && !stored.some(([, row]) => !row.closed)) return;
    const events = await this.page(sessionId), active = new Set();
    for (const question of pending) {
      const key = JSON.stringify([sessionId, question.callId ?? question.requestId]); active.add(key);
      let row = this.table.get(key);
      if (!row) {
        const route = this.route(sessionId, events); if (!route) continue;
        const nativeCallId = question.callId ?? events.findLast(event => event.type === 'tool/call' && event.data?.name === 'ask_user_question')?.data.callId;
        row = {...question, ...route, sessionId, nativeCallId, available:true, answers: [], code: (await requestId(key)).replaceAll('-', '').slice(0, 12)};
        await this.table.put(key, row);
      } else if (!row.closed) {
        const continued=row.state!=='continued'&&question.state==='continued'&&row.announced;
        row = {...row, requestId: question.requestId, state: question.state, available:true}; await this.table.put(key, row);
        if(continued&&bridge.channels.has(row.channel))await bridge.send(row.channel,row.target,`提问 ${row.code} 的等待时间已结束，Agent 已继续执行。仍可用 /answer ${row.code} <答案> 补答。`,`question:${key}:continued`);
      }
      if (!row.closed && !row.announced && bridge.channels.has(row.channel)) await this.announce(key, row);
    }
    for (const [key, row] of stored) {
      if (row.closed || active.has(key)) continue;
      // The waterfall can settle before its tool result is committed. Wait for durable evidence.
      const result = events.findLast(event => event.type === 'tool/result' && event.data?.message?.toolCallId === row.nativeCallId);
      const reply = events.some(event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply' && event.data.source.callId === row.nativeCallId);
      if (!result && !reply && events.at(-1)?.type !== 'turn/end') {await this.table.put(key,{...row,available:false});continue;}
      await this.table.put(key, {...row, closed: true});
      if (row.announced && bridge.channels.has(row.channel)) await bridge.send(row.channel, row.target, `提问 ${row.code} 已结束，可在 Weft 查看处理结果。`, `question:${key}:closed`);
    }
    // Retain a bounded set of closed identities to reject stale quoted replies.
    const ended = [...this.table.entries()].filter(([, row]) => row.closed||row.available===false);
    for (const [key] of ended.slice(0, Math.max(0, ended.length - 500))) await this.table.delete(key);
  }
  async announce(key, row) {
    const bridge = this.bridge;
    // Reserve the send first. Uncertain provider responses are not automatically repeated.
    await this.table.put(key, {...row, announced: true});
    await bridge.stopActivity(row.chatKey);
    await bridge.updateCard(row.chatKey, '需要你回答问题，请查看聊天中的提问。');
    const receipts = await bridge.send(row.channel, row.target, questionText(row, bridge.config.webUrl), `question:${key}:${row.answers.length}`);
    const current = this.table.get(key);
    if (current && !current.closed) await this.table.put(key, {...current, receipts: [...new Set([...(current.receipts ?? []), ...receipts])].slice(-64)});
  }
  async receive(message) {
    const bridge = this.bridge, chatKey = `${message.channel}:${message.conversation}`, text = message.text.trim();
    if(!this.enabled){
      if(/^\/(answer|questions)\b/i.test(text)){await bridge.send(message.channel,message.target,'当前宿主尚未提供 IM 原生提问接口，请更新 Weft 后使用。');return true;}
      return false;
    }
    const explicit = /^\/answer\s+([a-f0-9]{12})\s+([\s\S]+)$/i.exec(text), listing = /^\/questions\s*$/i.test(text);
    if (/^\/answer\b/i.test(text) && !explicit) {await bridge.send(message.channel, message.target, '用法：/answer <提问编号> <答案>'); return true;}
    // Refresh authority before accepting an answer; a Web reply may have won since the last hint.
    const rows = [...this.table.entries()].filter(([, row]) => row.chatKey === chatKey);
    for (const sessionId of new Set(rows.filter(([, row]) => !row.closed).map(([, row]) => row.sessionId))) await this.sync(sessionId);
    const candidates = [...this.table.entries()].filter(([, row]) => row.chatKey === chatKey);
    let selected = explicit ? candidates.find(([, row]) => row.code === explicit[1].toLowerCase())
      : message.replyTo ? candidates.find(([, row]) => row.receipts?.includes(message.replyTo)) : undefined;
    const own = candidates.filter(([, row]) => !row.closed && row.available!==false && row.sender === message.sender);
    if (listing) {
      if (!own.length) await bridge.send(message.channel, message.target, '当前没有等待你回答的问题。');
      for (const [key, row] of own) await this.announce(key, row);
      return true;
    }
    const current=own.filter(([,row])=>row.sessionId===bridge.conversations.get(chatKey)?.sessionId);
    if (!selected && !explicit && !message.replyTo && (!text.startsWith('/') || text==='/skip') && current.length === 1 && !message.attachments?.length) selected = current[0];
    if (!selected) {
      if (explicit) {await bridge.send(message.channel, message.target, '未找到本聊天中的这条提问，请发送 /questions 查看。'); return true;}
      if (!text.startsWith('/') && current.length > 1) {await bridge.send(message.channel, message.target, '有多个待回答的问题，请引用提问消息，或使用 /answer <提问编号> <答案>。'); return true;}
      return false;
    }
    const [key, row] = selected;
    if (row.sender !== message.sender) {await bridge.send(message.channel, message.target, '请由发起这次请求的人回答。'); return true;}
    const live = await bridge.ctx.sessionController.questions({sessionId: row.sessionId});
    const question = live.find(question => (question.callId ?? question.requestId) === (row.callId ?? row.requestId));
    if (row.closed || !question) {await bridge.send(message.channel, message.target, `提问 ${row.code} 已处理或已取消，请勿重复回答。`); return true;}
    try {
      const next = parseQuestionAnswer(row.questions[row.answers.length], explicit ? explicit[2] : text), answers = [...row.answers, next];
      if (answers.length < row.questions.length) {const updated = {...row, answers}; await this.table.put(key, updated); await this.announce(key, updated); return true;}
      const pendingId=question.state==='continued'?`question:${question.callId}`:undefined;
      if(pendingId)await bridge.conversations.update(row.chatKey,current=>({...current,pending:[...new Set([...current.pending,pendingId])]}));
      let accepted;
      try{accepted = await bridge.ctx.sessionController.answerQuestion({sessionId: row.sessionId, requestId: question.requestId, answer: {answers}});}
      catch(error){if(pendingId)await bridge.conversations.update(row.chatKey,current=>({...current,pending:current.pending.filter(id=>id!==pendingId)}));throw error;}
      if(!accepted&&pendingId)await bridge.conversations.update(row.chatKey,current=>({...current,pending:current.pending.filter(id=>id!==pendingId)}));
      await this.table.put(key, {...row, answers, closed: true});
      await bridge.send(message.channel, message.target, accepted ? `提问 ${row.code} 的回答已提交。` : `提问 ${row.code} 已处理或已取消，请勿重复回答。`);
      if (accepted) {bridge.startActivity(row.chatKey); bridge.follow(row.chatKey);}
    } catch (error) {await bridge.send(message.channel, message.target, `回答未提交：${error instanceof Error ? error.message : String(error)}`);}
    return true;
  }
}
