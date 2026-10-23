import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import type {DocumentCache} from './cache.ts';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 256 * 1024;
export interface DocumentResult {markdown: string; mimeType: string; tokens: number; extraction: string}
export class DocumentConversionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {super(message); this.name = 'DocumentConversionError';}
}
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** PPTX text is extracted in the Worker; CF converts the resulting HTML without a CLI or Office engine. */
export function presentationHtml(bytes: Uint8Array): string {
  let expanded = 0, slides = 0;
  const entries = unzipSync(bytes, {filter: file => {
    if (!/^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(file.name)) return false;
    if (++slides > 1000) throw new DocumentConversionError('DOCUMENT_INVALID', 'PPTX has more than 1000 slides');
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
  private readonly memory = new Map<string, DocumentResult>();
  private readonly pending = new Map<string, Promise<DocumentResult>>();
  private formats: {value: {extension: string; mimeType: string}[]; expires: number} | undefined;
  constructor(private readonly ai: Pick<Ai, 'toMarkdown'> | undefined, private readonly cache?: DocumentCache, private readonly timeoutMs = 30000) {}
  async convert(name: string, bytes: Uint8Array) {
    if (!this.ai) throw new DocumentConversionError('DOCUMENT_SERVICE_UNAVAILABLE', 'Cloudflare Workers AI binding is required for document conversion');
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentConversionError('DOCUMENT_TOO_LARGE', 'Document exceeds the 10 MiB input limit');
    if (!bytes.byteLength) throw new DocumentConversionError('DOCUMENT_EMPTY', 'The source document is empty');
    const key = createHash('sha256').update('weft-markdown-v2\0').update(name).update('\0').update(bytes).digest('hex');
    const cached = this.cache?.get(key) ?? this.memory.get(key);
    if (cached) return {...cached, cache: 'hit' as const};
    const existing = this.pending.get(key);
    if (existing) return {...await existing, cache: 'shared' as const};
    if (this.pending.size >= 4) throw new DocumentConversionError('DOCUMENT_BUSY', 'Four documents are already converting. Retry shortly.', true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([
      this.transform(name, bytes),
      new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new DocumentConversionError('DOCUMENT_TIMEOUT', 'Document conversion timed out after 30 seconds. Retry or split the document.', true)), this.timeoutMs);}),
    ]).then(value => {
      this.cache?.put(key, value);
      if (!this.cache) {if (this.memory.size >= 8) this.memory.delete(this.memory.keys().next().value!); this.memory.set(key, value);}
      return value;
    }).catch((error: unknown) => {
      if (error instanceof DocumentConversionError) throw error;
      throw new DocumentConversionError('DOCUMENT_SERVICE_ERROR', 'The document conversion service is unavailable. Retry shortly.', true);
    }).finally(() => {clearTimeout(timer); this.pending.delete(key);});
    this.pending.set(key, work);
    return {...await work, cache: 'miss' as const};
  }
  private async transform(name: string, bytes: Uint8Array): Promise<DocumentResult> {
    const extension = posix.extname(name).toLowerCase();
    const supported = this.formats && this.formats.expires > Date.now() ? this.formats.value : await this.ai!.toMarkdown().supported();
    this.formats = {value: supported, expires: Date.now() + 300000};
    const format = supported.find(item => item.extension.replace(/^\./, '').toLowerCase() === extension.slice(1));
    let blob: Blob, conversionName = name, extraction = 'cloudflare';
    if (!format && extension === '.pptx') {
      try {blob = new Blob([presentationHtml(bytes)], {type: 'text/html'});}
      catch {throw new DocumentConversionError('DOCUMENT_INVALID', 'PPTX is invalid or exceeds the slide extraction limit');}
      conversionName = name+'.html'; extraction = 'pptx-text-via-cloudflare';
    } else {
      if (!format) throw new DocumentConversionError('DOCUMENT_UNSUPPORTED_FORMAT', 'Cloudflare Markdown conversion does not support this document format: '+extension);
      blob = new Blob([new Uint8Array(bytes).buffer], {type: format.mimeType});
    }
    const result = await this.ai!.toMarkdown({name: conversionName, blob});
    if (result.format === 'error') throw new DocumentConversionError('DOCUMENT_CONVERSION_FAILED', 'Cloudflare document conversion failed: '+String(result.error ?? 'The source could not be converted').slice(0, 400));
    if (new TextEncoder().encode(result.data).byteLength > MAX_MARKDOWN_BYTES) throw new DocumentConversionError('DOCUMENT_OUTPUT_TOO_LARGE', 'Converted Markdown exceeds the 256 KiB output limit; split the source document');
    const value = {markdown: result.data, mimeType: result.mimeType ?? (result as unknown as {mimetype?: string}).mimetype ?? 'application/octet-stream', tokens: result.tokens, extraction};
    return value;
  }
}
