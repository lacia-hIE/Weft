import {Buffer} from 'node:buffer';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const fileName = value => String(value || 'file').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 240) || 'file';
export const base64 = value => Buffer.from(value).toString('base64');
export function imageType(data) {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
export function checkedUrl(raw, hosts) {
  const url = new URL(String(raw).startsWith('//') ? 'https:' + raw : raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('附件地址不受信任。');
  return url;
}
export async function readDownload(response, maxBytes = MAX_ATTACHMENT_BYTES) {
  if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error(`附件下载失败：HTTP ${response.status}`);}
  if (Number(response.headers.get('content-length')) > maxBytes) {await response.body.cancel(); throw new Error('附件超过大小限制。');}
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('附件超过大小限制。');
      parts.push(value);
    }
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  return Buffer.concat(parts, size);
}
export async function download(raw, hosts, options = {}, maxBytes = MAX_ATTACHMENT_BYTES) {
  return readDownload(await fetch(checkedUrl(raw, hosts), {...options, redirect: 'manual', signal: options.signal ?? AbortSignal.timeout(30_000)}), maxBytes);
}

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
function weixinKey(item) {
  if (typeof item.aeskey === 'string' && /^[a-f\d]{32}$/i.test(item.aeskey)) return Buffer.from(item.aeskey, 'hex');
  const key = Buffer.from(item.media?.aes_key ?? '', 'base64');
  if (key.length === 16) return key;
  if (key.length === 32 && /^[a-f\d]{32}$/i.test(key.toString())) return Buffer.from(key.toString(), 'hex');
  throw new Error('微信附件密钥无效。');
}
export function weixinAttachments(message) {
  return (message.item_list ?? []).filter(item => item.image_item || item.file_item).map(item => {
    const image = !!item.image_item, source = item.image_item ?? item.file_item;
    return {name: fileName(source.file_name || (image ? 'image' : 'file')), image,
      async load() {
        const url = source.media?.encrypt_query_param ? `${CDN}/download?encrypted_query_param=${encodeURIComponent(source.media.encrypt_query_param)}` : source.media?.full_url;
        const encrypted = await download(url, ['novac2c.cdn.weixin.qq.com'], {}, MAX_ATTACHMENT_BYTES + 16);
        const decipher = createDecipheriv('aes-128-ecb', weixinKey(source), null);
        const data = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 10 MiB。');
        return data;
      }};
  });
}
export async function sendWeixinAttachment(call, current, target, file) {
  const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(file.data), cipher.final()]);
  const upload = await call(current.baseUrl, 'ilink/bot/getuploadurl', {token: current.token, signal: file.signal, body: {
    filekey, media_type: file.image ? 1 : 3, to_user_id: target.to, rawsize: file.data.length,
    rawfilemd5: createHash('md5').update(file.data).digest('hex'), filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex'),
  }});
  if (upload.ret || upload.errcode) throw new Error('微信拒绝附件上传。');
  const url = upload.upload_full_url || `${CDN}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param ?? '')}&filekey=${filekey}`;
  const checked = checkedUrl(url, ['novac2c.cdn.weixin.qq.com']);
  if (!['/c2c/upload'].includes(checked.pathname) || !upload.upload_full_url && !upload.upload_param) throw new Error('微信上传地址无效。');
  const response = await fetch(checked, {method: 'POST', body: encrypted, headers: {'content-type': 'application/octet-stream'}, redirect: 'manual', signal: AbortSignal.any([...(file.signal ? [file.signal] : []), AbortSignal.timeout(60_000)])});
  const param = response.headers.get('x-encrypted-param');
  await response.body?.cancel();
  if (!response.ok || !param) throw new Error('微信附件上传失败。');
  const media = {encrypt_query_param: param, aes_key: base64(Buffer.from(key.toString('hex'))), encrypt_type: 1};
  const item = file.image ? {type: 2, image_item: {media, mid_size: encrypted.length}} : {type: 4, file_item: {media, file_name: file.name, len: String(file.data.length)}};
  file.signal?.throwIfAborted();
  const sent = await call(current.baseUrl, 'ilink/bot/sendmessage', {token: current.token, signal: file.signal, body: {msg: {
    from_user_id: '', to_user_id: target.to, client_id: file.deliveryId, message_type: 2, message_state: 2,
    item_list: [item], ...(target.contextToken ? {context_token: target.contextToken} : {}),
  }}});
  if (sent.ret || sent.errcode) throw new Error('微信拒绝附件消息。');
}
