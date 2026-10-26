import {AsyncLocalStorage} from 'node:async_hooks';
import {webhookDelivery} from './webhook-contracts.ts';
import {snapshotJsonValue} from '@deepseek-ai/dsh-util-values';
import {Context} from '@deepseek-ai/cordis';
import WebhookRuntime, {type VerifiedWebhookDelivery,type WebhookRule,type WebhookSessionRequest} from '@deepseek-ai/dsh-webhook';

interface Host {
  dispatchWebhook(delivery:unknown):Promise<void>;
  createWebhook(operationId:string,delivery:unknown,ruleId:string,request:unknown):Promise<void>;
  cancelWebhook(operationId:string):Promise<void>;
}
/** Worker transport around the original registry. Rule callbacks never leave their isolate. */
export class WorkerWebhooks {
  private runtime!:WebhookRuntime;
  private readonly admissions=new AsyncLocalStorage<Promise<void>[]>();
  constructor(private readonly host:Host,private readonly waitUntil:(work:Promise<unknown>)=>void) {}
  async mount(ctx:Context):Promise<void> {
    const owner=this;
    ctx.provide('weftWebhookSessions',{create(delivery:VerifiedWebhookDelivery,ruleId:string,request:WebhookSessionRequest,signal:AbortSignal){
      signal.throwIfAborted();const operationId=crypto.randomUUID();
      const abort=()=>owner.waitUntil(owner.host.cancelWebhook(operationId).catch(()=>{}));
      signal.addEventListener('abort',abort,{once:true});
      const pending=owner.host.createWebhook(operationId,delivery,ruleId,request).finally(()=>signal.removeEventListener('abort',abort));
      owner.waitUntil(pending.catch(()=>{}));return pending;
    }});
    class WorkerRuntime extends WebhookRuntime {static override inject=['weftWebhookSessions'];}
    const fiber=ctx.plugin(WorkerRuntime);await fiber.await();this.runtime=fiber.ctx.webhookRuntime;
  }
  readonly service={
    register:<K extends string>(rule:WebhookRule<K>)=>this.runtime.register({...rule,run:(delivery:Readonly<VerifiedWebhookDelivery<K>>,signal:AbortSignal)=>{
      const pending=Promise.resolve().then(()=>rule.run(delivery,signal));this.waitUntil(pending.catch(()=>{}));return pending;
    }}),
    dispatch:<K extends string>(delivery:VerifiedWebhookDelivery<K>):void=>{
      // Admission is awaited by the HTTP carrier before it returns 202. Execution stays fire-and-forget.
      const parsed=webhookDelivery.parse(snapshotJsonValue(delivery));
      const pending=this.host.dispatchWebhook(parsed);this.admissions.getStore()?.push(pending);this.waitUntil(pending.catch(()=>{}));
      // Keep failures observed until the carrier drains the admission batch.
      void pending.catch(()=>{});
    },
  };
  async run<T>(operation:()=>Promise<T>):Promise<T> {
    return this.admissions.run([],async()=>{const value=await operation();await Promise.all(this.admissions.getStore()!);return value;});
  }
  async deliver(delivery:VerifiedWebhookDelivery):Promise<void> {this.runtime.dispatch(delivery);await Promise.resolve();}
}
