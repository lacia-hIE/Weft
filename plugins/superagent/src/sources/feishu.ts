/** Feishu Source: messages of the Feishu bot that dsh-im assigns to dsh-superagent, with topic and chat context for assessments. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { HostIm } from '../host-services.ts'
import { botField, BotKeySchema, botScope, imTriggerId, refreshBots, sendIm } from './im.ts'
import type { ContextMessage, ContextPart, Localized, SourceKind } from './kind.ts'

const SOURCE = 'feishu'
const FeishuConfigSchema = z.object({
  bot: BotKeySchema.default(''),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>

/** A message as dsh-im's `read` returns it. */
const ReadMessageSchema = z.looseObject({ id: z.string(), sender: z.looseObject({ id: z.string(), bot: z.boolean() }), at: z.string(), text: z.string(),
  parentId: z.string().optional(), deleted: z.boolean().optional() })
const ReadPageSchema = z.looseObject({ messages: z.array(ReadMessageSchema), next: z.string().optional() })
const contextMessage = (message: z.infer<typeof ReadMessageSchema>): ContextMessage => ({ id: message.id, from: message.sender.id, at: message.at, text: message.text,
  ...message.sender.bot ? { bot: true as const } : {}, ...message.deleted ? { deleted: true as const } : {}, ...message.parentId ? { reply_to: message.parentId } : {} })
/** Feishu AppLink that opens a chat. */
export const feishuChatLink = (chatId: string): string => `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
const mentions = { zh: '仅 @', en: '@ only' }

/**
 * The Feishu Source kind. A message's Thread is its topic root, so replies in a topic join the Thread of the message
 * that opened it; assessments read the topic, or the newest page of a chat without topics, through the bot.
 */
export function feishuKind(im: HostIm, id: string = SOURCE): SourceKind<FeishuConfig> {
  const read = async (bot: string, argument: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return ReadPageSchema.parse(await im.call(bot, 'read', argument))
  }
  const kind: SourceKind<FeishuConfig> = {
    kind: id, ...(id !== SOURCE ? {type: SOURCE} : {}),
    title: { zh: '飞书', en: 'Feishu' },
    description: { zh: '接收 dsh-im 交给 dsh-superagent 的飞书机器人在下列群和私聊中收到的消息，并在话题里回复。', en: 'Receives the messages of the Feishu bot that dsh-im assigns to dsh-superagent in these chats and direct messages, and replies in their topics.' },
    schema: FeishuConfigSchema,
    fields: [
      botField(SOURCE, '飞书', 'Feishu'),
      { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
        hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作，需要机器人有读取全部群消息的权限。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all group messages.' },
        columns: [
          { key: 'chatId', type: 'text', label: { zh: '群 chat_id', en: 'Chat chat_id' }, pattern: 'oc_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
          { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: mentions }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
        ] },
      { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: mentions }],
        hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
      { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    ],
    health: [id],
    refreshLabels: host => refreshBots(im, host, { kind: id, health: [id] }, SOURCE),
    scope({ meta }, config) {
      const other = botScope(meta, config.bot)
      if (other) return other
      if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
      const chat = config.chats.find(item => item.chatId === meta.chatId)
      if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
      // As in a listed "@ only" chat, the Policy admits only mentions and follow-ups on Threads with Tickets.
      return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
    },
    // A reply goes only to a chat the Source still receives.
    channel: {
      allowed: (address, config) => kind.scope!({ meta: { bot: address.bot, chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
      send: message => sendIm(im, message, SOURCE),
      link: address => ({ url: feishuChatLink(address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
        ...address.messageId ? { triggerId: imTriggerId(id, address.messageId) } : {} }),
    },
    threadContext: {
      messageId: trigger => String(trigger.meta.messageId ?? ''),
      async read(trigger, part, cursor, _config, signal): Promise<ContextPart> {
        const meta = trigger.meta as { bot?: string; chatId?: string; messageId?: string; rootId?: string; parentId?: string; threadId?: string }
        if (!meta.bot || meta.bot !== _config.bot || trigger.source !== id) throw new Error('This message no longer belongs to the configured Feishu connection')
        if (part === 'root' || part === 'parent') {
          const id = part === 'root' ? meta.rootId ?? meta.messageId : meta.parentId
          const messages = id ? (await read(meta.bot, { part: 'message', messageId: id }, signal)).messages.map(contextMessage) : []
          return { messages, body: { messages } }
        }
        if (meta.threadId) {
          const page = await read(meta.bot, { part: 'thread', threadId: meta.threadId, ...cursor ? { pageToken: cursor } : {} }, signal)
          const messages = page.messages.map(contextMessage)
          return { messages, next: page.next, body: { status: 'topic', messages, ...page.next ? { next: page.next } : {} }, status: 'topic' }
        }
        // A chat without topics: the newest page around the message, oldest first; older pages would break the order.
        const page = await read(meta.bot, { part: 'chat', chatId: meta.chatId }, signal)
        const messages = page.messages.map(contextMessage).reverse()
        return { messages, body: { status: 'chat_neighbours', messages }, status: 'chat_neighbours' }
      },
    },
    find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
    // A message's Trigger is named after the message, so the one it answers is named after its parent.
    repliesTo: (trigger: Trigger) => typeof trigger.meta.parentId === 'string' ? imTriggerId(id, trigger.meta.parentId) : undefined,
    policy: {
      unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } },
      schema: z.object({
        allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
          .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
        bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
          .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
      }).strict(),
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work' },
          columns: [{ key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
        { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
          hint: { zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
          columns: [{ key: 'id', type: 'text', label: { zh: 'App ID 或 open_id', en: 'App ID or open_id' }, pattern: '(cli|ou)_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
      rows(stored) {
        const config = FeishuConfigSchema.parse(stored)
        const status = (on: boolean): Localized => on ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' }
        return [
          ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
            cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
          { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : status(false),
            cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
          { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: status(config.directMessages),
            cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
        ]
      },
    },
    environment: {
      variables: [{ key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: { zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空。智能体只通过 dsh-superagent 的工具回复飞书', en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu. The agent replies on Feishu only through dsh-superagent\'s tools' } }],
      values: ({ trigger }) => ({ DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
    },
  }
  return kind
}
