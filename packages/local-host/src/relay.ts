/** Carrier only: the native Host owns RPC, sessions, files and plugin resources. */
export const LOCAL_PROTOCOL = 'weft-local-host/1';
export const MAX_FRAME = 128 * 1024;
export const CHUNK_BYTES = 32 * 1024;
const LIMIT = 64;
type SocketIdentity={role:'host'|'browser';environmentId:string;id?:string;hostId?:string};
type Frame={type:string;id:string;[key:string]:unknown};
type Pending={socket:WebSocket;resolve:(response:Response)=>void;reject:(error:Error)=>void;controller?:ReadableStreamDefaultController<Uint8Array>;ack?:(()=>void)|undefined;responseAck?:boolean;timer:ReturnType<typeof setTimeout>;abort:()=>void;cleanup:()=>void};
export function localPath(path:string):boolean {
  path=path.split('?')[0]!;
  return path.startsWith('/')&&!path.startsWith('//')&&!/[\\\r\n\0]/.test(path)&&!/%(?:2f|5c|2e)/i.test(path)
    &&!path.split(/[/?#]/).includes('..')&&(path==='/'||path.startsWith('/api/')||path.startsWith('/plugins/')||path.startsWith('/assets/'));
}
export function encode(bytes:Uint8Array):string {let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
export function decode(text:string):Uint8Array {if(text.length>CHUNK_BYTES*4/3+4)throw new Error('Chunk limit');return Uint8Array.from(atob(text),char=>char.charCodeAt(0));}
export async function hashKey(key:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function newKey():string {return [...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function safeHeaders(input:Headers):[string,string][] {
  return ['content-type','accept','range','if-none-match','if-modified-since'].flatMap(key=>input.has(key)?[[key,input.get(key)!] as [string,string]]:[]);
}
const responseHeaders=new Set(['content-type','content-disposition','etag','last-modified','accept-ranges','content-range']);
export class LocalHostRelay {
  private readonly pending=new Map<string,Pending>();
  constructor(private readonly ctx:DurableObjectState){}
  host(environmentId:string):WebSocket|undefined{return this.ctx.getWebSockets('local-host').find(socket=>{const a=socket.deserializeAttachment() as SocketIdentity;return a.environmentId===environmentId&&socket.readyState===1;});}
  disconnect(environmentId:string):void {
    for(const socket of this.ctx.getWebSockets()) {const a=socket.deserializeAttachment() as SocketIdentity|null;if(a?.environmentId===environmentId)socket.close(1000,'Local environment disconnected');}
    for(const [id,p] of this.pending)if((p.socket.deserializeAttachment() as SocketIdentity).environmentId===environmentId)this.fail(id,new Error('Local Host disconnected'));
  }
  acceptHost(environmentId:string):Response {
    this.disconnect(environmentId);
    const pair=new WebSocketPair(),socket=pair[1];
    socket.serializeAttachment({role:'host',environmentId,id:crypto.randomUUID()} satisfies SocketIdentity);
    this.ctx.acceptWebSocket(socket,['local-host']);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async proxy(environmentId:string,request:Request,path:string):Promise<Response> {
    const socket=this.host(environmentId);
    if(!socket)return Response.json({error:'本地 DSH 未连接，请启动本地 DSH 后重试'},{status:503,headers:{'cache-control':'private, no-store'}});
    if(!localPath(path)||!['GET','HEAD','POST'].includes(request.method))return new Response('Unsupported local Host route',{status:400});
    if(request.headers.get('upgrade')?.toLowerCase()==='websocket'){
      if(path!=='/api/remote.mux')return new Response('Unsupported socket',{status:404});
      if(this.ctx.getWebSockets('local-browser').length>=LIMIT)return new Response('Connection limit',{status:429});
      const pair=new WebSocketPair(),id=crypto.randomUUID();pair[1].serializeAttachment({role:'browser',environmentId,id,hostId:(socket.deserializeAttachment() as SocketIdentity).id!} satisfies SocketIdentity);
      this.ctx.acceptWebSocket(pair[1],['local-browser']);socket.send(JSON.stringify({type:'ws-open',id}));
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(this.pending.size>=LIMIT)return new Response('Request limit',{status:429});
    const id=crypto.randomUUID();
    const reader=request.body?.getReader();
    const result=new Promise<Response>((resolve,reject)=>{
      const abort=()=>this.fail(id,new Error('Request cancelled'));
      const timer=setTimeout(()=>this.fail(id,new Error('Local Host response timed out')),30_000);
      this.pending.set(id,{socket,resolve,reject,timer,abort,cleanup:()=>{request.signal.removeEventListener('abort',abort);void reader?.cancel().catch(()=>{});}});
      request.signal.addEventListener('abort',abort,{once:true});
    });
    void result.catch(()=>{});
    try {
      socket.send(JSON.stringify({type:'request',id,method:request.method,path,headers:safeHeaders(request.headers)}));
      // Upload and response run concurrently: a native early error (for example
      // a rejected file admission) must not deadlock behind the remaining body.
      const upload=(async()=>{
        try {if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;for(let offset=0;offset<chunk.value.length;offset+=CHUNK_BYTES){
          const p=this.pending.get(id);if(!p)return;
          await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Upload timed out')),30_000);p.ack=()=>{clearTimeout(timer);resolve();};socket.send(JSON.stringify({type:'chunk',id,body:encode(chunk.value.subarray(offset,offset+CHUNK_BYTES))}));});
        }}
        if(this.pending.has(id))socket.send(JSON.stringify({type:'end',id}));
        }catch{this.fail(id,new Error('Local upload failed'));}finally{reader?.releaseLock();}
      })();
      this.ctx.waitUntil(upload);
      const response=await result;
      if(!response.body){const p=this.pending.get(id);if(p){clearTimeout(p.timer);p.cleanup();this.pending.delete(id);}}
      return response;
    }catch{this.fail(id,new Error('Local Host request failed'));return new Response('Local Host request failed',{status:502,headers:{'cache-control':'private, no-store'}});}
  }

  message(socket:WebSocket,data:string|ArrayBuffer):void {
    const identity=socket.deserializeAttachment() as SocketIdentity;
    if(typeof data!=='string'||data.length>MAX_FRAME){socket.close(1009,'Frame limit');this.closed(socket);return;}
    if(identity.role==='browser') {
      const host=this.host(identity.environmentId);if(!host||(host.deserializeAttachment() as SocketIdentity).id!==identity.hostId){socket.close(1011,'Local Host offline');return;}
      host.send(JSON.stringify({type:'ws-data',id:identity.id,text:data}));return;
    }
    let frame:Frame;try{frame=JSON.parse(data) as Frame;if(typeof frame.type!=='string'||typeof frame.id!=='string')throw new Error();}catch{socket.close(1008,'Invalid frame');this.closed(socket);return;}
    if(frame.type.startsWith('ws-')){
      const browser=this.ctx.getWebSockets('local-browser').find(s=>{const a=s.deserializeAttachment() as SocketIdentity;return a.id===frame.id&&a.environmentId===identity.environmentId&&a.hostId===identity.id;});
      if(!browser)return;
      if(frame.type==='ws-data'&&typeof frame.text==='string')browser.send(frame.text);
      else if(frame.type==='ws-close')browser.close(1011,'Local stream ended');return;
    }
    const p=this.pending.get(frame.id);if(!p||(p.socket.deserializeAttachment() as SocketIdentity).id!==identity.id)return;
    try {
      if(frame.type==='ack'){const ack=p.ack;p.ack=undefined;ack?.();return;}
      if(frame.type==='response'){
        if(p.controller)throw new Error('Duplicate response');clearTimeout(p.timer);
        if(!Number.isInteger(frame.status)||Number(frame.status)<200||Number(frame.status)>599||!Array.isArray(frame.headers))throw new Error('Invalid response');
        const headers=new Headers();for(const [key,value] of frame.headers as [string,string][])if(responseHeaders.has(key.toLowerCase()))headers.set(key,value);
        headers.set('cache-control','private, no-store');headers.set('x-content-type-options','nosniff');
        const body=new ReadableStream<Uint8Array>({start:controller=>{p.controller=controller;},pull:()=>{if(p.responseAck){p.responseAck=false;socket.send(JSON.stringify({type:'ack',id:frame.id}));}},cancel:()=>this.fail(frame.id,new Error('Response cancelled'))},{highWaterMark:1});
        p.resolve(new Response([204,205,304].includes(Number(frame.status))?null:body,{status:Number(frame.status),headers}));
      }else if(frame.type==='chunk'&&typeof frame.body==='string'){
        if(!p.controller||p.responseAck)throw new Error('Response overflow');p.controller.enqueue(decode(frame.body));
        if((p.controller.desiredSize??0)>0)socket.send(JSON.stringify({type:'ack',id:frame.id}));else p.responseAck=true;
      }else if(frame.type==='end'){
        p.controller?.close();clearTimeout(p.timer);p.cleanup();this.pending.delete(frame.id);
      }else if(frame.type==='error')this.fail(frame.id,new Error('Local Host operation failed'));
      else throw new Error('Invalid frame');
    }catch{this.fail(frame.id,new Error('Invalid local response'));}
  }
  private fail(id:string,error:Error):void {const p=this.pending.get(id);if(!p)return;clearTimeout(p.timer);p.cleanup();this.pending.delete(id);p.ack?.();p.reject(error);try{p.controller?.error(error);}catch{}try{p.socket.send(JSON.stringify({type:'cancel',id}));}catch{}}
  closed(socket:WebSocket):void {
    const a=socket.deserializeAttachment() as SocketIdentity;
    if(a.role==='host'){for(const [id,p] of this.pending)if((p.socket.deserializeAttachment() as SocketIdentity).id===a.id)this.fail(id,new Error('Local Host disconnected'));for(const browser of this.ctx.getWebSockets('local-browser'))if((browser.deserializeAttachment() as SocketIdentity).hostId===a.id)browser.close(1011,'Local Host disconnected');}
    else try{this.host(a.environmentId)?.send(JSON.stringify({type:'ws-close',id:a.id}));}catch{}
  }
}
