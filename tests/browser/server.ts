import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { createRuntime } from "../helpers/miniflare.ts";
import { modelGate } from './model-gate.ts';

// Test-only bridge. Production serves directly from the authenticated Worker.
// Native Access identities are supplied by Miniflare, never application headers.
const live = process.env.WEFT_BROWSER_LIVE === "1";
const queue = process.env.WEFT_BROWSER_QUEUE === '1' ? modelGate() : undefined;
if (live && queue) throw new Error('Choose a live provider or the controlled queue provider');
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
    : queue ? {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'queue-browser-fixture', DEEPSEEK_BASE_URL: 'https://browser-model.test/anthropic'}, outbound: queue.outbound} : { browser: true },
);
await runtime.ready;
const server = createServer(async (request, response) => {
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
      if (value && name !== "host")
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    if (headers.has("origin")) headers.set("origin", "http://alpha.local");
    const body = Buffer.concat(buffers);
    const result = await runtime.dispatchFetch(
      "http://alpha.local" + request.url,
      {
        method: request.method ?? "GET",
        headers: [...headers],
        ...(body.length ? { body } : {}),
      },
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
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
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
