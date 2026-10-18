import { createSecureServer } from "node:http2";
import { Readable } from "node:stream";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { createRuntime } from "../helpers/miniflare.ts";
import { modelGate } from './model-gate.ts';
import { nativePluginModel } from '../helpers/native-plugin-model.ts';

// Test-only bridge. Production serves directly from the authenticated Worker.
// Native Access identities are supplied by Miniflare, never application headers.
const live = process.env.WEFT_BROWSER_LIVE === "1";
const queue = process.env.WEFT_BROWSER_QUEUE === '1' ? modelGate() : undefined;
const plugins = process.env.WEFT_BROWSER_PLUGINS === '1' ? nativePluginModel() : undefined;
if (Number(live) + Number(!!queue) + Number(!!plugins) > 1) throw new Error('Choose one browser model transport');
const key = live
  ? readFileSync(".env", "utf8").match(
      /^DEEPSEEK_API_KEY\s*=\s*["']?([^\r\n"']+)/m,
    )?.[1]
  : undefined;
if (live && !key) throw new Error("Missing live model configuration");
const runtime = createRuntime(
  undefined,
  key
    ? {
        bindings: { MODEL_BACKEND: "deepseek", DEEPSEEK_API_KEY: key },
        browser: true,
      }
    : queue ? {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'queue-browser-fixture', DEEPSEEK_BASE_URL: 'https://browser-model.test/anthropic'}, outbound: queue.outbound}
      : plugins ? {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'plugin-browser-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: plugins.outbound}
        : { browser: true },
);
await runtime.ready;
// Native Harness opens several concurrent Remote streams. Match CF's HTTP/2
// multiplexing instead of exhausting the browser's six HTTP/1 connections.
const tlsDirectory = mkdtempSync(join(tmpdir(), 'weft-browser-tls-'));
const cert = join(tlsDirectory, 'cert.pem'), keyFile = join(tlsDirectory, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-days', '1'], {stdio: 'ignore'});
const server = createSecureServer({key: readFileSync(keyFile), cert: readFileSync(cert), allowHTTP1: true}, async (request, response) => {
  try {
    if (queue && request.url === '/__test/model-gate') {
      if (request.method === 'POST') queue.release();
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({calls: queue.calls()}));
      return;
    }
    const buffers: Buffer[] = [];
    for await (const part of request) buffers.push(Buffer.from(part));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value && name !== "host" && !name.startsWith(':'))
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    if (headers.has("origin")) headers.set("origin", "http://alpha.local");
    const body = Buffer.concat(buffers);
    const abort = new AbortController();
    response.on('close', () => {if (!response.writableEnded) abort.abort();});
    const result = await runtime.dispatchFetch(
      "http://alpha.local" + request.url,
      {
        method: request.method ?? "GET",
        headers: [...headers],
        signal: abort.signal,
        ...(body.length ? { body } : {}),
      },
    );
    response.writeHead(result.status, Object.fromEntries([...result.headers].filter(([name]) => !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name))));
    if (result.body) {
      const stream = Readable.fromWeb(result.body as never);
      response.on('close', () => { if (!response.writableEnded) stream.destroy(); });
      stream.on('error', () => { response.destroy(); });
      stream.pipe(response);
    } else response.end();
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
server.listen(4173, "127.0.0.1", () => {
  console.log("Browser verification server ready on 4173");
});
async function close(): Promise<void> {
  server.close();
  await runtime.dispose();
  rmSync(tlsDirectory, {recursive: true, force: true});
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
