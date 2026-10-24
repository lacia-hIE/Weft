import {AsyncLocalStorage} from 'node:async_hooks';

export type LifecycleMode='active'|'suspended'|'deleting'|'deleted';
type Context={gate:LifecycleGate;epoch:number;maintenance:boolean};
const contexts=new AsyncLocalStorage<Context>();

/** Local durable admission, including continuations created before a pause. */
export class LifecycleGate {
  mode:LifecycleMode;
  private epoch:number;
  operation:number;
  private booting=true;
  private readonly pending=new Set<Promise<unknown>>();
  private readonly streams=new Set<()=>void>();
  constructor(readonly raw:DurableObjectStorage) {
    this.schema();
    const row=raw.sql.exec<{mode:LifecycleMode;epoch:number;operation:number}>('SELECT * FROM weft_lifecycle WHERE id=1').one();
    this.mode=row.mode;this.epoch=row.epoch;this.operation=row.operation;
  }
  private schema():void {
    this.raw.sql.exec('CREATE TABLE IF NOT EXISTS weft_lifecycle (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,epoch INTEGER NOT NULL,operation INTEGER NOT NULL) STRICT');
    this.raw.sql.exec("INSERT OR IGNORE INTO weft_lifecycle VALUES (1,'active',0,0)");
  }
  finishBoot():void {this.booting=false;}
  assert():void {
    const context=contexts.getStore();
    if(this.booting)return;
    if(context?.gate===this && context.epoch!==this.epoch)throw new Error('Environment operation was superseded');
    if(context?.gate===this && context.maintenance)return;
    if(this.mode!=='active')throw new Error(`Environment is ${this.mode}`);
  }
  maintenance<T>(work:()=>T):T {return contexts.run({gate:this,epoch:this.epoch,maintenance:true},work);}
  transition(mode:LifecycleMode,operation:number,force=false):void {
    if(!Number.isSafeInteger(operation)||operation<1||operation<this.operation)throw new Error('Stale environment lifecycle operation');
    if(this.mode==='deleted' && mode!=='deleted')throw new Error('Environment was deleted');
    if(force||mode!==this.mode||operation!==this.operation){this.epoch++;this.mode=mode;this.operation=operation;this.persist();}
  }
  private persist():void {this.raw.sql.exec('UPDATE weft_lifecycle SET mode=?,epoch=?,operation=? WHERE id=1',this.mode,this.epoch,this.operation);}
  track(promise:Promise<unknown>):void {
    this.pending.add(promise);
    void promise.finally(()=>this.pending.delete(promise)).catch(()=>{});
  }
  run<T>(work:()=>T):T {
    this.assert();
    if(contexts.getStore()?.gate===this)return work();
    const context:Context={gate:this,epoch:this.epoch,maintenance:false};
    const result=contexts.run(context,work);
    if(result instanceof Promise){this.track(result);return result.then(value=>this.bindResult(value,context)) as T;}
    return this.bindResult(result,context);
  }
  private bindResult<T>(value:T,context:Context):T {
    if(!(value instanceof Response)||!value.body||value.status===101)return value;
    const reader=value.body.getReader();let close:()=>void;
    const stream=new ReadableStream<Uint8Array>({
      start:controller=>{close=()=>{try{controller.error(new Error('Environment connection closed'));}catch{}void reader.cancel().catch(()=>{});this.streams.delete(close);};this.streams.add(close);},
      pull:controller=>contexts.run(context,async()=>{try{this.assert();const part=await reader.read();if(part.done){controller.close();this.streams.delete(close);}else controller.enqueue(part.value);}catch(error){this.streams.delete(close);controller.error(error);}}),
      cancel:reason=>{this.streams.delete(close);return reader.cancel(reason);},
    });
    return new Response(stream,{status:value.status,statusText:value.statusText,headers:value.headers}) as T;
  }
  closeStreams():void {for(const close of [...this.streams])close();}
  async drain():Promise<void> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([Promise.allSettled([...this.pending]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Environment operations are still stopping; retry')),15_000);})]);}
    finally {clearTimeout(timer);}
  }
  async purge(operation:number):Promise<void> {
    this.transition('deleting',operation);
    await this.raw.deleteAlarm();await this.raw.deleteAll();
    this.schema();this.mode='deleted';this.operation=operation;this.epoch++;this.persist();await this.raw.sync();
  }
  state(ctx:DurableObjectState):DurableObjectState {
    const sql=new Proxy(ctx.storage.sql,{get:(target,key)=>{const value=Reflect.get(target,key,target);return typeof value==='function'?(...args:unknown[])=>{this.assert();return Reflect.apply(value,target,args);}:value;}});
    const storage=new Proxy(ctx.storage,{get:(target,key)=>{if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?(...args:unknown[])=>{this.assert();return Reflect.apply(value,target,args);}:value;}});
    return new Proxy(ctx,{get:(target,key)=>{
      if(key==='storage')return storage;
      if(key==='blockConcurrencyWhile')return <T>(work:()=>Promise<T>)=>{const boot=this.booting;return target.blockConcurrencyWhile(()=>boot?this.maintenance(work):work());};
      if(key==='waitUntil')return (promise:Promise<unknown>)=>{if(!contexts.getStore()?.maintenance)this.track(promise);target.waitUntil(promise);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }
}

/** Keep public RPC and internal async callbacks on the same generation. */
export function guardLifecycle(type:{prototype:object},admit?:(owner:any,args:unknown[])=>Promise<void>|void):void {
  const skipped=new Set(['constructor','nativeLifecycle','nativeCopyRelease','nativeRegisterResource','releaseCopy','alarm']);
  let prototype=type.prototype;
  while(prototype && Object.getPrototypeOf(prototype)!==Object.prototype){
    for(const name of Object.getOwnPropertyNames(prototype)){
      if(skipped.has(name))continue;
      const descriptor=Object.getOwnPropertyDescriptor(prototype,name);
      if(typeof descriptor?.value!=='function')continue;
      const method=descriptor.value;
      Object.defineProperty(type.prototype,name,{...descriptor,value:function(this:{lifecycle:LifecycleGate},...args:unknown[]){
        const nested=contexts.getStore()?.gate===this.lifecycle;
        return this.lifecycle.run(()=>{
          if(admit && !nested && !contexts.getStore()?.maintenance && args[0] && typeof args[0]==='object' && 'tenantId' in args[0]){
            const pending=admit(this,args);if(pending)return pending.then(()=>{this.lifecycle.assert();return method.apply(this,args);});
          }
          return method.apply(this,args);
        });
      }});
    }
    prototype=Object.getPrototypeOf(prototype);
    // DurableObject's own platform methods are not application entrypoints.
    if(prototype?.constructor?.name==='DurableObject')break;
  }
}
