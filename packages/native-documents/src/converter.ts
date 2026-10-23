import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 256 * 1024;
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** PPTX text is extracted in the Worker; CF converts the resulting HTML without a CLI or Office engine. */
export function presentationHtml(bytes: Uint8Array): string {
  let expanded = 0;
  const entries = unzipSync(bytes, {filter: file => {
    if (!/^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(file.name)) return false;
    expanded += file.originalSize;
    if (expanded > 16 * 1024 * 1024) throw new Error('PPTX slide text exceeds the extraction limit');
    return true;
  }});
  const names = Object.keys(entries).sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]));
  if (!names.length || names.length > 1000) throw new Error('Invalid or oversized PPTX presentation');
  const parser = new XMLParser({preserveOrder: true, ignoreAttributes: true, processEntities: false});
  const texts = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(texts);
    if (!node || typeof node !== 'object') return [];
    const fields = node as Record<string, unknown>;
    if ('a:t' in fields) return [(fields['a:t'] as Record<string, unknown>[]).map(item => String(item['#text'] ?? '')).join('')];
    return Object.values(fields).flatMap(texts);
  };
  return '<!doctype html><html><body>'+names.map((name, index) => `<section><h1>Slide ${index + 1}</h1>${texts(parser.parse(strFromU8(entries[name]!))).map(text => '<p>'+escapeHtml(text)+'</p>').join('')}</section>`).join('')+'</body></html>';
}

export class WorkerDocuments {
  private readonly cache = new Map<string, {markdown: string; mimeType: string; tokens: number; extraction: string}>();
  constructor(private readonly ai: Pick<Ai, 'toMarkdown'> | undefined) {}
  async convert(name: string, bytes: Uint8Array) {
    if (!this.ai) throw new Error('Cloudflare Workers AI binding is required for document conversion');
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the 10 MiB input limit');
    const key = createHash('sha256').update(name).update(bytes).digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;
    const extension = posix.extname(name).toLowerCase();
    const supported = await this.ai.toMarkdown().supported();
    const format = supported.find(item => item.extension.replace(/^\./, '').toLowerCase() === extension.slice(1));
    let blob: Blob, conversionName = name, extraction = 'cloudflare';
    if (!format && extension === '.pptx') {
      blob = new Blob([presentationHtml(bytes)], {type: 'text/html'});
      conversionName = name+'.html'; extraction = 'pptx-text-via-cloudflare';
    } else {
      if (!format) throw new Error('Cloudflare Markdown conversion does not support this document format: '+extension);
      blob = new Blob([new Uint8Array(bytes).buffer], {type: format.mimeType});
    }
    const result = await this.ai.toMarkdown({name: conversionName, blob});
    if (result.format === 'error') throw new Error('Cloudflare document conversion failed');
    if (new TextEncoder().encode(result.data).byteLength > MAX_MARKDOWN_BYTES) throw new Error('Converted Markdown exceeds the 256 KiB output limit');
    const value = {markdown: result.data, mimeType: result.mimeType ?? (result as unknown as {mimetype?: string}).mimetype ?? 'application/octet-stream', tokens: result.tokens, extraction};
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, value);
    return value;
  }
}

