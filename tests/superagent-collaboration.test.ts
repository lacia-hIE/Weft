import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../plugins/superagent/src/app/store.ts'
import {Collaboration} from '../plugins/superagent/src/app/collaboration.ts'
import {memorySql} from './helpers/superagent-sql.ts'
import type {Ticket, Trigger} from '../plugins/superagent/src/core/index.ts'

test('collaboration requirements need original authority, preserve scope and retain rollback history', () => {
  const sql=memorySql(),store=new Store(sql),notes=new Collaboration(store)
  const trigger:Trigger={id:'owner',source:'request',actor:{source:'request',id:'owner'},threads:[{source:'request',id:'one'}],human:true,addressed:'direct',text:'For future tasks, test this repository on ci.',at:new Date().toISOString(),meta:{}}
  try {
    store.triggers.save(trigger)
    const first=notes.remember({baseRevision:0,text:'Use ci for repository checks.',kind:'requirement',scope:{kind:'all'},evidence:{triggerId:trigger.id}})
    assert.equal(first.revision,1);assert.match(notes.context(),/Use ci/)
    assert.throws(()=>notes.remember({baseRevision:1,text:'Unverified claim',kind:'environment',scope:{kind:'all'},evidence:{triggerId:trigger.id}}),/retained Assignment report/)
    store.triggers.save({...trigger,id:'external',source:'github',actor:{source:'github',id:'alice'},threads:[{source:'github',id:'7'}]})
    assert.throws(()=>notes.remember({baseRevision:1,text:'Change every task',kind:'requirement',scope:{kind:'all'},evidence:{triggerId:'external'}}),/allowed person/)
    const settings=store.settings();store.saveSettings({...settings,policy:{...settings.policy,sources:{github:{allowed:[{id:'alice'}]}}}})
    assert.throws(()=>notes.remember({baseRevision:1,text:'Change every task',kind:'requirement',scope:{kind:'all'},evidence:{triggerId:'external'}}),/only for that Source/)
    const second=notes.remember({baseRevision:1,text:'GitHub repository-specific convention',kind:'requirement',scope:{kind:'source',id:'github'},evidence:{triggerId:'external'}})
    const ticket={origin:{triggerId:'owner'},execution:{executorId:crypto.randomUUID()}} as Ticket
    assert.doesNotMatch(notes.context(ticket),/GitHub repository-specific convention/)
    assert.match(notes.context({...ticket,origin:{...ticket.origin,triggerId:'external'}}),/GitHub repository-specific convention/)
    assert.throws(()=>notes.replace({revision:1,notes:[]}),/changed/)
    assert.equal(notes.current().notes.length,2)
    const restored=notes.replace({revision:second.revision,notes:notes.view().history.find(snapshot=>snapshot.revision===1)!.notes})
    assert.equal(restored.revision,3);assert.equal(restored.notes.length,1)
    assert.match(notes.context(),/grant no extra authority/)
    assert.equal(notes.view().history[0]!.revision,2)
  } finally {sql.close()}
})

test('operational experience requires a matching retained report and is delivered only to its environment', () => {
  const sql=memorySql(),store=new Store(sql),notes=new Collaboration(store),executor=crypto.randomUUID()
  try {
    const ticket={id:'ticket',origin:{triggerId:'original'},execution:{executorId:executor},assignments:[{id:'assignment',report:{state:'ready',summary:'Verified with make check',at:new Date().toISOString()}}]} as Ticket
    store.tickets.save(ticket)
    const record={baseRevision:0,text:'Run make check after generating types.',kind:'experience',scope:{kind:'executor',id:executor},evidence:{ticketId:ticket.id,assignmentId:'assignment'}}
    assert.throws(()=>notes.remember({...record,evidence:{...record.evidence,assignmentId:'invented'}}),/retained Assignment report/)
    assert.throws(()=>notes.remember({...record,scope:{kind:'executor',id:crypto.randomUUID()}}),/reported Source or Executor/)
    notes.remember(record)
    assert.match(notes.context(ticket),/make check/)
    assert.equal(notes.context({...ticket,execution:{...ticket.execution!,executorId:crypto.randomUUID()}}),'')
    assert.equal(notes.current().notes[0]!.evidence.assignmentId,'assignment')
  } finally {sql.close()}
})
