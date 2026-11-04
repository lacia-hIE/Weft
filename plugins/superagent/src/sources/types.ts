/** Connector types are distinct from stable, independently configured Source identities. */
export const SOURCE_TYPES = ['github-webhook', 'gitlab', 'feed', 'feishu', 'weixin', 'qq', 'email'] as const
export type SourceType = typeof SOURCE_TYPES[number]
