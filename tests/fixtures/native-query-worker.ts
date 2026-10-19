import {DurableObject} from 'cloudflare:workers';
import {Context} from '@deepseek-ai/cordis';
import Sessions, {SessionId, SessionSeq, type SessionEvent} from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import {createAssistantMessage, createUserMessage} from '@deepseek-ai/dsh-llm';
import type {SessionSearchRequest, SessionEventSearchRequest} from '@deepseek-ai/dsh-session-query';
import {initializeSessionStorage, SqliteSessionPersistence, readSessionMetadata, readSessionEventPage} from '../../packages/session-persistence-do/src/index.ts';
import {installDurableSessionQuery} from '../../packages/native-query/src/index.ts';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';
import {NativeSessionSearch} from '../../packages/native-query/src/host.ts';

interface Env {QUERY: DurableObjectNamespace<QueryDO>}
function messages(text: string, time: number): SessionEvent[] {
  return [{seq: SessionSeq(0), time, type: 'user/message',
    data: createUserMessage({content: [{type: 'text', text}], source: {kind: 'user'}}), surfaceOp: 'append'}];
}

/** Test-only owner of real Session services, persistence and the native provider. */
export class QueryDO extends DurableObject<Env> {
  private root: Promise<Context> | undefined;
  private list: ApiSessionList | undefined;
  private search: NativeSessionSearch | undefined;
  private abortRead: AbortController | undefined;
  private pageReads = 0;
  private maxPageBytes = 0;
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, env); initializeSessionStorage(ctx.storage);}
  private context(): Promise<Context> {
    return this.root ??= (async () => {
      const ctx = new Context();
      await ctx.plugin(Sessions);
      await ctx.plugin(Projections);
      await ctx.plugin(SqliteSessionPersistence, {storage: this.ctx.storage});
      await installDurableSessionQuery(ctx, this.ctx.storage);
      return ctx;
    })();
  }

  override async fetch(request: Request): Promise<Response> {
    const input = await request.json() as {mode: string; records?: {id: string; text: string; time?: number}[]; id?: string; text?: string; query?: SessionSearchRequest; events?: SessionEventSearchRequest; failure?: boolean};
    try {
      const ctx = await this.context();
      let value: unknown;
      switch (input.mode) {
        case 'seed':
          for (const [index, record] of input.records!.entries()) {
            const id = SessionId(record.id);
            const header = {...ctx.sessions.prepare(id).header, createdAt: record.time ?? index + 1, cwd: '/workspace'};
            const writer = await ctx.sessionPersistence.create(header);
            try {await writer.append(messages(record.text, header.createdAt));} finally {await writer.close();}
          }
          value = {count: (await ctx.sessionPersistence.list()).length};
          break;
        case 'large': {
          const id = SessionId('large');
          const header = {...ctx.sessions.prepare(id).header, cwd: '/workspace'};
          const writer = await ctx.sessionPersistence.create(header);
          try {
            await writer.append(Array.from({length: 80}, (_, index) => ({...messages('界'.repeat(20000) + (index === 79 ? ' last-page-needle' : ''), index + 1)[0]!, seq: SessionSeq(index)})));
          } finally {await writer.close();}
          value = {count: 80};
          break;
        }
        case 'remote-search': {
          this.search ??= new NativeSessionSearch(this.ctx.storage, {
            ids: async () => (await ctx.sessionPersistence.list()).map(record => record.header.id),
            metadata: async id => readSessionMetadata(this.ctx.storage, SessionId(id)),
            page: async (id, offset, end) => {
              const events = readSessionEventPage(this.ctx.storage, SessionId(id), offset, end);
              this.pageReads++; this.maxPageBytes = Math.max(this.maxPageBytes, new TextEncoder().encode(JSON.stringify(events)).byteLength);
              this.abortRead?.abort(); this.abortRead = undefined;
              return events;
            },
          });
          const abort = new AbortController();
          if (input.failure) this.abortRead = abort;
          value = {result: await this.search.search(input.text!, abort.signal), pages: this.pageReads, maxPageBytes: this.maxPageBytes};
          break;
        }
        case 'live': {
          const session = ctx.sessions.create(SessionId(input.id!), {seed: messages(input.text!, 500), meta: {cwd: '/workspace', createdAt: 500}});
          value = {id: session.id};
          break;
        }
        case 'assistant': {
          const session = ctx.sessions.get(SessionId(input.id!))!;
          session.append('assistant/message', {stream: [], turn: 1, step: 1,
            message: createAssistantMessage({content: [{type: 'reasoning', text: 'private-reasoning-marker'}, {type: 'text', text: input.text!}], source: {provider: 'validation', model: 'scripted'}})}, {surfaceOp: 'append'});
          value = {id: session.id};
          break;
        }
        case 'search': value = await ctx.sessionQuery.searchSessions(input.query!); break;
        case 'runtime-search': {
          const runtime = new Context();
          try {
            await runtime.plugin(Sessions); await runtime.plugin(Projections);
            await runtime.plugin(SqliteSessionPersistence, {storage: this.ctx.storage});
            await installDurableSessionQuery(runtime, this.ctx.storage, 'runtime');
            value = await runtime.sessionQuery.searchSessions(input.query!);
          } finally {await runtime.fiber.dispose();}
          break;
        }
        case 'api-search': value = await (this.list ??= new ApiSessionList(ctx, 8)).search(input.text!, request.signal); break;
        case 'events': value = await ctx.sessionQuery.searchEvents(input.events!); break;
        case 'reset':
          await this.search?.dispose(); this.search = undefined;
          await ctx.fiber.dispose(); this.root = undefined; this.list = undefined;
          value = {reset: true};
          break;
        case 'failure':
          ctx.weftSessionSearchDatabase.open();
          if (input.failure) this.ctx.storage.sql.exec("CREATE TRIGGER reject_query_index BEFORE INSERT ON weft_query_persisted_sessions WHEN NEW.id='fault-b' BEGIN SELECT RAISE(ABORT,'search fixture'); END");
          else this.ctx.storage.sql.exec('DROP TRIGGER reject_query_index');
          value = {failure: input.failure};
          break;
        case 'stats':
          value = {canonical: this.ctx.storage.sql.exec('SELECT count(*) AS count FROM harness_sessions').one().count,
            indexed: this.ctx.storage.sql.exec('SELECT count(*) AS count FROM weft_query_persisted_sessions').one().count,
            live: this.ctx.storage.sql.exec('SELECT count(*) AS count FROM weft_query_live_sessions').one().count};
          break;
        default: throw new Error('Unknown query fixture mode');
      }
      return Response.json({value});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : String(error), code: (error as {code?: string}).code}, {status: 400});
    }
  }
}
export default {fetch(request: Request, env: Env) {return env.QUERY.getByName(new URL(request.url).pathname.slice(1) || 'query').fetch(request);}} satisfies ExportedHandler<Env>;
