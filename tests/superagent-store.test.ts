import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySql } from './helpers/superagent-sql.ts'
import { afterEach, beforeEach, expect, it, vi } from './helpers/spec.ts'
import { Store, SCHEMA_VERSION } from '../plugins/superagent/src/app/store.ts'

const open = (path: string, report?: (error: unknown) => void) => new Store(memorySql(path), report)
import { MemoryRepositories, key, type Assignment, type Decision, type Repositories, type Thread, type Ticket } from '../plugins/superagent/src/core/index.ts'
import { threadFacts } from '../plugins/superagent/src/app/views/records.ts'
import { KV } from '../plugins/superagent/src/kv.ts'
import { SettingsSchema } from '../plugins/superagent/src/policy.ts'


let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('refuses databases newer than this build and rolls back failed atomic work', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = open(path)
  expect(() => store.atomic(() => { store.set('a', 1); throw new Error('boom') })).toThrow('boom')
  expect(store.get('a')).toBeUndefined()
  store.set('schema', SCHEMA_VERSION + 1)
  expect(() => open(path)).toThrow('Unsupported')
})
it('finds triggers by thread', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  store.triggers.save({ id: 'a', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '2', text: 'later', meta: {} })
  store.triggers.save({ id: 'b', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }, { source: 'github', id: '3' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '1', text: 'earlier', meta: {} })
  store.triggers.save({ id: 'c', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_y_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '3', text: 'other', meta: {} })
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['b', 'a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  // Saving a Trigger again replaces the Threads it is found on.
  store.triggers.save({ ...store.triggers.get('b')!, threads: [{ source: 'github', id: '3' }] })
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  expect(store.read.subscribedThreads()).toEqual([])
})
const ticket = (id: string, state: 'open' | 'ended', assignments: Pick<Assignment, 'state'>[], undelivered: string[] = []): Ticket => ({
  id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
  ...state === 'ended' ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } } : {},
  undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
const thread = (id: string, source: string, fields: Partial<Thread> = {}): Thread =>
  ({ key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields })
const ids = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key).sort()
it('reads the working sets alone, in SQLite as in memory, and follows each save', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
    repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
    // A retry or a resume adds a pending Assignment after the ones that ended.
    repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
    // An ended Ticket a person's message reached without resuming it, which versions before schema 11 left to their next pass.
    repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
    repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github', { pending: ['a'] }))
    repo.threads.save(thread('2', 'github', { subscriptions: ['running'], evaluating: { id: 'e', threadKey: 'github:2', triggerIds: ['b'], strength: 'explicit',
      actor: { source: 'github', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
    repo.threads.save(thread('oc:om', 'feishu', { subscriptions: ['done'] }))
    repo.threads.save(thread('3', 'github'))
    expect(ids(repo.tickets.open())).toEqual(['queued', 'running'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'running', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:1', 'github:2'])
    repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github'))
    expect(ids(repo.tickets.open())).toEqual(['queued'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:2'])
  }
  expect(ids(store.read.subscribedThreads())).toEqual(['feishu:oc:om', 'github:2'])
  expect(ids(store.read.subscribedThreads('github'))).toEqual(['github:2'])
})
it('names a thread by its first human trigger', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  const base = { source: 'github', threads: [{ source: 'github', id: '5' }], actor: { source: 'github', id: 'x' }, meta: {} }
  store.triggers.save({ ...base, id: 'ci', human: false, at: '1', text: 'GitHub PR #5 CI: {}' })
  store.triggers.save({ ...base, id: 'person', human: true, at: '2', text: 'please look' })
  expect(store.read.firstTrigger('github:5')?.id).toBe('ci')
  expect(store.read.firstTrigger('github:5', true)?.id).toBe('person')
})

it('counts triggers per Source and lists them newest first, optionally only the filtered ones', () => {
  const store = open(join(directory, 'db.sqlite'))
  const trigger = (id: string, source: string, at: string) => ({ id, source, threads: [{ source, id: 'x' }], actor: { source, id: 'a' }, human: true, at, text: id, meta: {} })
  store.triggers.save(trigger('old', 'feishu', '2026-09-01T00:00:00Z'))
  store.triggers.save(trigger('kept', 'feishu', '2026-09-23T00:00:00Z'))
  store.triggers.save(trigger('dropped', 'feishu', '2026-09-23T01:00:00Z'))
  store.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
  store.triggers.save(trigger('gh', 'github', '2026-09-22T00:00:00Z'))
  expect(store.read.triggerStats('2026-09-22T12:00:00Z')).toEqual({ feishu: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00Z' }, github: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00Z' } })
  expect(store.read.triggers({ source: 'feishu' }, 0, 2)).toEqual({ items: [expect.objectContaining({ id: 'dropped' }), expect.objectContaining({ id: 'kept' })], more: true })
  expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(['dropped'])
})

it('links a Thread to the page its Source named, or else to the message that started it', () => {
  const store = open(join(directory, 'links.sqlite'))
  const thread = (keyValue: string, source: string, id: string, meta: Record<string, unknown> = {}) => store.threads.save({ key: keyValue, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta })
  thread('github:7', 'github', '7', { url: 'https://github.com/acme/widgets/pull/7' })
  thread('feishu:oc_1:om_1', 'feishu', 'oc_1:om_1')
  store.triggers.save({ id: 'f1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true, at: '1', text: 'hi', url: 'https://applink.feishu.cn/client/message/link/open?token=t', meta: {} })
  expect(threadFacts(store, store.threads.get('github:7')!).url).toBe('https://github.com/acme/widgets/pull/7')
  expect(threadFacts(store, store.threads.get('feishu:oc_1:om_1')!).url).toBe('https://applink.feishu.cn/client/message/link/open?token=t')
})

it('sets and removes a Source\'s keys in a Thread\'s meta', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { isPr: true, gone: true } })
  store.threads.patchMeta('github:5', { gone: undefined, title: 'Fix' })
  expect(store.threads.get('github:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
  store.threads.patchMeta('github:6', { title: 'none' })
  expect(store.threads.get('github:6')).toBeUndefined()
})
it('runs what waits for a commit once the outermost transaction commits, and never what a rolled back one queued', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  const ran: string[] = []
  store.atomic(() => {
    store.afterCommit(() => { ran.push('outer') })
    store.atomic(() => { store.afterCommit(() => { ran.push('inner') }) })
    expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') })).toThrow('boom')
    // Nothing runs before the outermost transaction commits.
    expect(ran).toEqual([])
  })
  expect(ran).toEqual(['outer', 'inner'])
  expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('failed') }); throw new Error('boom') })).toThrow('boom')
  store.afterCommit(() => { ran.push('outside') })
  expect(ran).toEqual(['outer', 'inner', 'outside'])
})

it('reports an action that fails after a commit, runs the others, and keeps what committed', () => {
  const reported: unknown[] = []
  const store = open(join(directory, 'orchestrator.sqlite'), error => { reported.push(error) })
  const ran: string[] = []
  const value = store.atomic(() => {
    store.set(KV.runtime.masterId, 'm')
    store.afterCommit(() => { throw new Error('cancel failed') })
    store.afterCommit(() => { ran.push('next') })
    return 'done'
  })
  expect(value).toBe('done')
  expect(ran).toEqual(['next'])
  expect(reported).toEqual([new Error('cancel failed')])
  expect(store.get(KV.runtime.masterId)).toBe('m')
})

it('keeps the settings as versions: the current settings are the snapshot of the current revision, kept nowhere else', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  expect(store.settings()).toEqual(SettingsSchema.parse({}))
  store.saveSettings({ ...store.settings(), paused: true }, { source: 'panel', block: 'pause', policyVersion: 'v', policyChanged: false, notified: [] })
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 5 } })
  expect(store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  expect(store.settingsHistory().map(version => [version.revision, version.source])).toEqual([[2, 'internal'], [1, 'panel']])
  expect([store.get(KV.settings.revision), store.blockRevision('pause'), store.keys('settings').filter(name => name === 'settings')]).toEqual([2, 1, []])
})

it('lists in the same order in SQLite and in memory, and undoes a failed nested transaction alone in both', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  const order = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key)
  const decision = (id: string): Decision => ({ id, evalId: '', threadKey: 'github:1', triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [],
    strength: 'explicit' })
  const run = (repo: Repositories) => {
    repo.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    repo.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    repo.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    // Saving a ticket again keeps its place.
    repo.tickets.save({ ...repo.tickets.get('first')!, title: 'again' })
    repo.threads.save(thread('1', 'github', { pending: ['a'] })); repo.threads.save(thread('2', 'github')); repo.threads.save(thread('3', 'github', { pending: ['b'] }))
    repo.decisions.save(decision('d2'))
    repo.decisions.save(decision('d1'))
    // A failed nested transaction undoes its own writes; the one around it goes on and keeps its own.
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', 'open', []))
      expect(() => repo.atomic(() => { repo.tickets.save(ticket('inner', 'open', [])); throw new Error('boom') })).toThrow('boom')
    })
    return { tickets: order(repo.tickets.list()), open: order(repo.tickets.open()), active: order(repo.tickets.active()), threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()), decisions: order(repo.decisions.byThread('github:1')) }
  }
  const memory = run(new MemoryRepositories())
  expect(memory).toEqual({ tickets: ['outer', 'third', 'second', 'first'], open: ['outer', 'third', 'first'], active: ['third', 'first'],
    threads: ['github:1', 'github:2', 'github:3'], activeThreads: ['github:1', 'github:3'], decisions: ['d2', 'd1'] })
  expect(run(store)).toEqual(memory)
})

it('reads `%` and `_` in a key prefix and a search query as written, not as patterns', () => {
  const store = open(join(directory, 'orchestrator.sqlite'))
  for (const name of ['a%b', 'axb', 'a_c', 'abc']) store.set(name, 1)
  expect([store.keys('a%').sort(), store.keys('a_').sort()]).toEqual([['a%b'], ['a_c']])
  const said = (id: string, text: string) => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'u' },
    human: true, at: '2026-10-01T00:00:00.000Z', text, meta: {} })
  for (const [id, text] of [['p', 'grew 50% today'], ['q', 'grew 500 today'], ['r', 'see a_b'], ['s', 'see axb']]) store.triggers.save(said(id!, text!))
  expect([store.read.search('50%').map(item => item.id), store.read.search('a_b').map(item => item.id)]).toEqual([['p'], ['r']])
})
