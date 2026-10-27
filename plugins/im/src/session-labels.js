// Adapted from xmanrui/dsh-im (MIT), b9baa78. See ../THIRD_PARTY_NOTICES.md.
const labels = {weixin: ['微信', 'WeChat'], feishu: ['飞书', 'Feishu'], qq: ['QQ']};

/** Exact prefixes only: message snippets and ordinary title substrings are not channel metadata. */
export function parseSessionChannelTitle(title) {
  if (typeof title !== 'string') return null;
  for (const [channel, names] of Object.entries(labels)) {
    // Older Weft releases pinned raw channel names. Keep their Sessions recognizable.
    for (const prefix of [...names.map(name => name + ' · '), `[${channel}] `]) {
      if (title.startsWith(prefix) && title.slice(prefix.length).trim()) return {channel, title: title.slice(prefix.length)};
    }
  }
  return null;
}
