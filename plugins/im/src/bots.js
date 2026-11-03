import Schema from '@deepseek-ai/schemastery';

/** Key of an added bot: its channel, `_` and six lowercase hex digits. */
const ADDED = /^(?:weixin|feishu|qq|email)_[0-9a-f]{6}$/;

/**
 * Configuration of one channel entry. The first bot keeps its fields at the top
 * level, so configuration from before added bots keeps its routes, storage and
 * conversations; added bots live under `bots`, keyed by their local key.
 * @param {() => Record<string, unknown>} fields - per-bot field schemas; called twice so each object owns its nodes.
 * @param {Record<string, unknown>} shared - entry fields every bot of the channel uses, such as the management key.
 */
export function botEntry(fields, shared) {
  return Schema.object({...fields(), ...shared,
    bots: Schema.dict(Schema.object(fields())).default({}).description('Added bots of this channel, keyed by channel, underscore and six hex digits.')});
}

/**
 * The bots of one channel entry. A bot's key is the channel name for the first
 * bot and `<channel>_<hex>` for an added one; it names the bot's routes,
 * storage, gateway connection and IM conversations, so it never changes.
 * @param {Record<string, unknown>} config - the entry configuration.
 * @param {string} channel - the channel the entry serves.
 * @param {string[]} shared - entry fields each added bot reads from the entry.
 * @returns {{key: string, config: Record<string, unknown>}[]}
 * @throws Error when an added bot's key does not belong to the channel.
 */
export function botsOf(config, channel, shared) {
  const {bots = {}, ...first} = config;
  const entry = Object.fromEntries(shared.map(name => [name, config[name]]));
  return [{key: channel, config: first}, ...Object.entries(bots).map(([key, bot]) => {
    if (!ADDED.test(key) || !key.startsWith(channel + '_')) throw new Error(`IM bot key ${key} does not belong to ${channel}`);
    return {key, config: {...bot, ...entry}};
  })];
}
