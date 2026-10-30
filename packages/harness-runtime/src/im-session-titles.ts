// Adapted from xmanrui/dsh-im (MIT), b9baa78. See plugins/im/THIRD_PARTY_NOTICES.md.
import type {Context} from '@deepseek-ai/cordis';
import type {Session} from '@deepseek-ai/dsh-session';

const labels: Record<string, readonly string[]> = {weixin: ['微信', 'WeChat'], feishu: ['飞书', 'Feishu'], qq: ['QQ'], email: ['邮箱', 'Email']};
const provenance = /^(weixin|feishu|qq|email)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Preserve native title sources/citations and automatic revisions. Never call rename. */
export function installImSessionTitles(ctx: Context): void {
  const pending = new Set<Session>();
  let closed = false;
  const decorate = (session: Session) => {
    if (closed || ctx.sessions.get(session.id) !== session) return;
    const events = session.snapshotEvents();
    // A Web fork inherits its parent's prompts, but not its IM identity.
    const inherited = session.inheritedEventCount;
    const own = events.filter(event => event.seq >= inherited);
    const channel = own.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source
      ? [provenance.exec(event.data.source.rpcId ?? '')?.[1]] : []).find(Boolean);
    if (!channel) return;
    const names = labels[channel]!;
    const latest = events.findLast(event => event.type === 'session/title');
    if (!latest || latest.type !== 'session/title' || !latest.data.title.trim()
      || names.some(label => latest.data.title.startsWith(label + ' · '))) return;
    // Append outside the observer stack and re-read the latest event: a stale
    // provider result must never overwrite a newer title or a manual rename.
    session.append('session/title', {...structuredClone(latest.data), title: `${names[0]} · ${latest.data.title}`});
  };
  const enqueue = (session: Session) => {
    if (closed || pending.has(session)) return;
    pending.add(session);
    queueMicrotask(() => {
      pending.delete(session);
      try {decorate(session);}
      catch (error) {console.warn('IM Session title decoration failed', error);}
    });
  };
  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title' || event.type === 'user/message') enqueue(session);
  }, {global: true});
  ctx.on('session/created', enqueue, {global: true});
  ctx.effect(() => () => {closed = true; pending.clear();}, 'IM Session title labels');
}
