/** IM Sources: messages of the IM bots that dsh-im assigns to dsh-superagent, and replies through the same bots. */
import { z } from 'zod'
import { isoTime, key, type ChannelRef, type OutboundMessage, type ScopeResult, type Trigger } from '../core/index.ts'
import type { HostIm } from '../host-services.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceHost } from './host.ts'
import type { AdmissionRowView, FieldSpec, Localized, SourceKind } from './kind.ts'

/** One message of an assigned bot as dsh-im hands it over; `target` is opaque and goes back with each reply. */
export const ImEventSchema = z.looseObject({
  kind: z.string(), messageId: z.string().min(1), chatId: z.string().min(1), direct: z.boolean(),
  sender: z.looseObject({ id: z.string(), name: z.string().optional(), bot: z.boolean() }),
  mentioned: z.boolean(), text: z.string(), at: z.string(), target: z.unknown(), title: z.string().optional(),
  rootId: z.string().optional(), parentId: z.string().optional(), threadId: z.string().optional(),
})
export type ImEvent = z.infer<typeof ImEventSchema>
/** Channels whose bots dsh-im can assign; each has a Source kind of the same name. */
export const IM_CHANNELS = ['feishu', 'weixin', 'qq', 'email'] as const
export type ImChannel = typeof IM_CHANNELS[number]
/** Key of a dsh-im bot: the channel for its first bot, `<channel>_<hex>` for an added one. */
export const BotKeySchema = z.string().regex(/^([a-z][a-z0-9_]{0,63})?$/)

/**
 * Stores the bots of `channel` that dsh-im assigns to dsh-superagent as the Source's labels, which the bot field offers.
 * @returns the labels by bot key.
 */
export async function refreshBots(im: HostIm, host: SourceHost, kind: { kind: string; health: readonly string[] }): Promise<Record<string, string>> {
  const labels = Object.fromEntries((await im.bots()).filter(item => item.kind === kind.kind).map(item => [item.bot, item.name ? `${item.name} · ${item.bot}` : item.bot]))
  sourceContext(host, kind).state.set(KV.sources.labels(kind.kind), labels)
  return labels
}
/** The bot field of an IM Source: a choice among the bots dsh-im assigns to dsh-superagent, or a key typed in. */
export function botField(channel: ImChannel, title: string, titleEn: string): FieldSpec {
  return { key: 'bot', type: 'text', pattern: '[a-z][a-z0-9_]*', label: { zh: '机器人', en: 'Bot' },
    choose: { zh: '选择交给本插件的机器人', en: 'Choose a bot assigned to this plugin' }, refresh: { zh: '刷新机器人列表', en: 'Refresh bots' },
    hint: { zh: `列出 dsh-im 中交给 @weft/dsh-superagent 的${title}机器人：在 dsh-im 的“更多设置 → 通用 → 交给插件”里选择本插件后，点刷新。列表为空时也可以直接填机器人的键：第一个${title}机器人是 ${channel}，新增的形如 ${channel}_0a1b2c。`,
      en: `Lists the ${titleEn} bots of dsh-im assigned to @weft/dsh-superagent: choose this plugin under More settings → General → Assign to plugin in dsh-im, then refresh. With an empty list, type the bot's key: ${channel} for the first ${titleEn} bot, ${channel}_0a1b2c for an added one.` } }
}

/** The Thread of a message: a Feishu topic or root message, an email conversation, or the whole chat elsewhere. */
export function imThread(event: ImEvent): string {
  if (event.kind === 'feishu') return `${event.chatId}:${event.rootId ?? event.messageId}`
  if (event.kind === 'email') return event.threadId ?? event.chatId
  return event.chatId
}
/** Deterministic Trigger id of a message; every delivery of one message has the same id. */
export const imTriggerId = (kind: string, messageId: string): string => key(kind, messageId)

/** Converts one message of `bot` into a Trigger of the Source `kind`; a direct message addresses the agent, as does a mention of the bot. */
export function imTrigger(kind: ImChannel, bot: string, event: ImEvent): Trigger {
  const thread = imThread(event)
  const channel: ChannelRef = { source: kind, thread: `${kind}:${thread}`,
    address: { bot, chatId: event.chatId, messageId: event.messageId, target: JSON.stringify(event.target ?? null), ...event.direct ? { direct: 'true' } : {} } }
  return { id: imTriggerId(kind, event.messageId), source: kind, threads: [{ source: kind, id: thread }],
    actor: { source: kind, id: event.sender.id }, human: !event.sender.bot,
    ...event.direct ? { addressed: 'direct' as const } : event.mentioned ? { addressed: 'mention' as const } : {},
    at: isoTime(event.at), text: event.title ? `${event.title}\n\n${event.text}` : event.text, channel,
    meta: { bot, chatId: event.chatId, messageId: event.messageId, direct: event.direct, mentioned: event.mentioned,
      ...event.sender.name ? { senderName: event.sender.name } : {}, ...event.rootId ? { rootId: event.rootId } : {},
      ...event.parentId ? { parentId: event.parentId } : {}, ...event.threadId ? { threadId: event.threadId } : {} } }
}

/**
 * Replies through the bot that received the Trigger, as recorded in its channel address; Feishu replies to a group
 * message in its topic. dsh-im makes a retried message the same message where its platform supports it.
 * @throws when the bot is no longer assigned to dsh-superagent or the platform refused the message; the Outbox retries.
 */
export async function sendIm(im: HostIm, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { bot, target, direct } = message.channel.address
  if (!bot || !target) return 'gone'
  const parsed = JSON.parse(target) as Record<string, unknown> | null
  if (!parsed) return 'gone'
  await im.call(bot, 'send', { target: message.channel.source === 'feishu' && direct !== 'true' ? { ...parsed, inThread: true } : parsed,
    text: message.text, deliveryId: message.id })
  return 'sent'
}

/** Scope shared by the IM kinds: only the configured bot's messages, then direct messages and group chats by setting. */
export function botScope(meta: Record<string, unknown>, bot: string): ScopeResult | undefined {
  if (!bot) return { listened: false, reason: 'bot_not_chosen' }
  return meta.bot === bot ? undefined : { listened: false, reason: 'bot_not_chosen' }
}

const GenericConfigSchema = z.object({ bot: BotKeySchema.default(''), directMessages: z.boolean().default(true), groupMentions: z.boolean().default(true) }).strict()
export type GenericImConfig = z.infer<typeof GenericConfigSchema>
const TITLES: Record<Exclude<ImChannel, 'feishu'>, Localized> = { weixin: { zh: '微信', en: 'WeChat' }, qq: { zh: 'QQ', en: 'QQ' }, email: { zh: '邮箱', en: 'Email' } }
const received = { zh: '接收', en: 'Received' }, refused = { zh: '不接收', en: 'Not received' }

/**
 * The Source of a WeChat, QQ or email bot assigned to dsh-superagent: each chat (an email conversation) is one Thread,
 * a direct message addresses the agent, and a QQ group message reaches the bot only when it mentions it.
 */
export function imKind(channel: Exclude<ImChannel, 'feishu'>, im: HostIm): SourceKind<GenericImConfig> {
  const groups = channel === 'qq'
  return {
    kind: channel,
    title: TITLES[channel],
    description: { zh: `接收 dsh-im 交给 dsh-superagent 的${TITLES[channel].zh}机器人收到的消息，并通过它回复。`,
      en: `Receives the messages of the ${TITLES[channel].en} bot that dsh-im assigns to dsh-superagent, and replies through it.` },
    schema: GenericConfigSchema,
    fields: [
      botField(channel, TITLES[channel].zh, TITLES[channel].en),
      { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
      ...groups ? [{ key: 'groupMentions', type: 'switch' as const, label: { zh: '接收群里 @ 机器人的消息', en: 'Group messages that mention the bot' } }] : [],
    ],
    health: [channel],
    refreshLabels: host => refreshBots(im, host, { kind: channel, health: [channel] }),
    scope: ({ meta }, config) => {
      const other = botScope(meta, config.bot)
      if (other) return other
      if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
      return groups && config.groupMentions ? { listened: true, observed: false, row: 'group' } : { listened: false, reason: 'chat_not_allowed' }
    },
    channel: { send: message => sendIm(im, message), link: () => ({ url: '', label: TITLES[channel] }) },
    find: () => ({ threads: [], terms: [] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: `能发起工作的${TITLES[channel].zh}用户`, en: `${TITLES[channel].en} users who may originate work` },
        columns: [{ key: 'id', type: 'text', label: { zh: channel === 'email' ? '邮箱地址' : '用户 ID', en: channel === 'email' ? 'Email address' : 'User ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
      explicit: { zh: '名单内的人私聊机器人，或在群里 @ 机器人，总是明确的请求。', en: 'Someone on the list who messages the bot directly, or mentions it in a group, always makes an explicit request.' },
      rows(stored): AdmissionRowView[] {
        const config = GenericConfigSchema.parse(stored)
        return [
          { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? received : refused,
            cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
          ...groups ? [{ id: 'group', label: { zh: '群里 @ 机器人', en: 'Group mentions' }, note: config.groupMentions ? received : refused,
            cells: { listedUnaddressed: false, unlistedAddressed: config.groupMentions, unlistedUnaddressed: false } }] : [],
        ]
      },
    },
  }
}
