import {test} from 'node:test'
import assert from 'node:assert/strict'
import {z} from 'zod'
import {Engine, latestAssignment, key, type Trigger, type Policy} from '../plugins/superagent/src/core/index.ts'
import {Store} from '../plugins/superagent/src/app/store.ts'
import {RemoteExecutor, EXECUTOR_PROTOCOL} from '../plugins/superagent/src/executor/remote.ts'
import {memorySql} from './helpers/superagent-sql.ts'

async function harness() {
  const sql = memorySql(), store = new Store(sql)
  let engine: Engine, calls = 0, selected = ''
  const remote = new RemoteExecutor({store, get engine() {return engine}, changed() {}, configuration: () => ({instructions: 'Own the task.', allow: ['read', 'bash']}),
    tools: ticket => [{name: 'orchestrator_report', description: 'Report', schema: z.object({state: z.enum(['progress', 'ready']), summary: z.string()}), execute: async args => {
      calls++; engine.report(ticket.id, args as {state: 'progress' | 'ready'; summary: string}); return {reported: true}
    }}]})
  const policy: Policy = {version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({admissible: true, strength: 'explicit', basis: {via: 'listed', sender: 'alice'}}), revalidate: () => true, admitsInferred: () => false}
  engine = new Engine({repo: store, scope: {scope: () => ({listened: true, observed: false})}, policy: () => policy,
    assessor: {request() {}}, executor: remote, outbox: {send() {}, status: () => 'pending', withdraw() {}},
    prepareTicket: ticket => ({...ticket, execution: {name: `work-${ticket.id.slice(0,12)}`, directory: `/workspace/${ticket.id}`, assignment: '', executorId: selected}})})
  const create = async (name: string) => {
    const code = await remote.create(name), paired = await remote.pair(code.id, code.pairingKey)
    return {...code, token: paired.token}
  }
  const first = await create('Mac'), second = await create('Linux')
  selected = first.id
  const accept = (id: string) => {
    const trigger: Trigger = {id: key(id), source: 'chat', threads: [{source: 'chat', id}], actor: {source: 'chat', id: 'alice'}, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Fix this project.', meta: {}, channel: {source: 'chat', thread: id, address: {}}}
    engine.receive(trigger); engine.evaluateDue(); engine.decide(trigger.id, {kind: 'accept', title: 'Fix', scope: 'requested work', reason: 'requested', name: 'fix'})
    return store.tickets.list().find(ticket => ticket.origin.triggerId === trigger.id)!
  }
  const sync = (id: string, states: unknown[] = [], accepting = true) => remote.sync(id, {protocol: EXECUTOR_PROTOCOL, accepting, states})
  return {sql, store, engine, remote, first, second, accept, sync, calls: () => calls}
}

test('remote placement persists, dispatch is replayable, and only the assigned computer sees a Ticket', async () => {
  const h = await harness()
  try {
    const ticket = h.accept('one'), assignment = latestAssignment(ticket)!
    assert.equal(h.sync(h.second.id).commands.length, 0)
    assert.equal(h.sync(h.first.id, [], false).commands.length, 0)
    const initial = h.sync(h.first.id).commands as {assignmentId: string; messages: {id: string}[]}[]
    assert.equal(initial.length, 1); assert.equal(initial[0]!.assignmentId, assignment.id)
    assert.deepEqual(h.sync(h.first.id).commands, initial, 'an unanswered dispatch retains the same identity')
    h.sync(h.first.id, [{ticketId: ticket.id, assignmentId: assignment.id, revision: 1, state: 'running', sessionId: 'native-session', accepted: initial[0]!.messages.map(message => message.id)}])
    assert.equal(latestAssignment(h.store.tickets.get(ticket.id)!)!.state, 'running')
    assert.equal(h.remote.status(ticket.id)?.sessionId, 'native-session')
    assert.equal(h.remote.activeCount(), 1)
    h.engine.stopTicket(ticket.id)
    assert.equal((h.sync(h.first.id).commands[0] as {kind: string}).kind, 'stop')
    h.sync(h.first.id, [{ticketId: ticket.id, assignmentId: assignment.id, revision: 2, state: 'stopped', sessionId: 'native-session', accepted: []}])
    assert.equal(h.sync(h.first.id).commands.length, 0)
    assert.equal(h.remote.status(ticket.id)?.state, 'stopped')
  } finally {h.sql.close()}
})

test('executor tokens cannot route work, cross assignments or repeat side effects', async () => {
  const h = await harness()
  try {
    const ticket = h.accept('two'), assignment = latestAssignment(ticket)!
    const request = {ticketId: ticket.id, assignmentId: assignment.id, requestId: 'native-tool-1', name: 'orchestrator_report', args: {state: 'progress', summary: 'Working'}}
    await assert.rejects(h.remote.call(h.second.id, request, new AbortController().signal), /authorized/)
    await assert.rejects(h.remote.call(h.first.id, {...request, name: 'orchestrator_route'}, new AbortController().signal), /not available/)
    assert.deepEqual(await h.remote.call(h.first.id, request, new AbortController().signal), {reported: true})
    assert.deepEqual(await h.remote.call(h.first.id, request, new AbortController().signal), {reported: true})
    assert.equal(h.calls(), 1)
    await assert.rejects(h.remote.call(h.first.id, {...request, args: {state: 'progress', summary: 'Different'}}, new AbortController().signal), /identity was reused/)
    h.engine.stopTicket(ticket.id)
    await assert.rejects(h.remote.call(h.first.id, {...request, requestId: 'later'}, new AbortController().signal), /authorized/)
  } finally {h.sql.close()}
})

test('pairing is single use, revocation persists, and global concurrency bounds dispatch', async () => {
  const h = await harness()
  try {
    await assert.rejects(h.remote.pair(h.first.id, h.first.pairingKey), /already used/)
    await h.remote.authenticate(h.first.id, h.first.token)
    await assert.rejects(h.remote.authenticate(h.second.id, h.first.token), /authorization/)
    h.store.saveSettings({...h.store.settings(), executor: {...h.store.settings().executor, maxWorkers: 1}})
    h.accept('three'); h.accept('four')
    assert.equal(h.sync(h.first.id).commands.length, 1)
    assert.equal(h.sync(h.first.id).commands.length, 1, 'only the already reserved Assignment is redelivered')
    h.remote.revoke(h.first.id)
    await assert.rejects(h.remote.authenticate(h.first.id, h.first.token), /authorization/)
    assert.equal(h.remote.list().length, 1)
  } finally {h.sql.close()}
})
