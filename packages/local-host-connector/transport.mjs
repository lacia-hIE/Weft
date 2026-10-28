import WebSocket from 'ws';
import {MuxChannel,MAX_MUX_BYTES,WINDOW} from './mux.mjs';
const PROTOCOL='weft-local-host/3',CHUNK=32*1024,MAX_FRAME=16*1024*1024,MAX_ACTIVE=64,BACKLOG=8*1024*1024;
// Only the private carrier is compressed; the relay restores the native bytes.
const compressible=type=>/^(?:text\/|application\/(?:javascript|json|xml|wasm)|image\/svg\+xml)/i.test(type??'');
const allowed=value=>{if(typeof value!=='string')return false;const path=value.split('?')[0];return path.startsWith('/')&&!path.startsWith('//')&&!/[\\\r\n\0]/.test(path)&&!/%(?:2f|5c|2e)/i.test(path)&&!path.split(/[/?#]/).includes('..')&&(path==='/'||path.startsWith('/api/')||path.startsWith('/plugins/')||path.startsWith('/assets/'));};
const headersAllowed=new Set(['content-type','accept','range','if-none-match','if-modified-since']);
const replyHeaders=new Set(['content-type','content-disposition','etag','last-modified','accept-ranges','content-range']);
const wait=(ms,signal)=>new Promise(resolve=>{const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();};const timer=setTimeout(stop,ms);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
export function validateEndpoint(value){
  const endpoint=new URL(value);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/v1\/local-hosts\/[a-zA-Z0-9_-]{1,80}\/[a-zA-Z0-9_-]{1,80}$/.test(endpoint.pathname))throw new Error('Invalid Weft connection endpoint');
  return endpoint;
}
/** Outbound-only transport; closing the plugin releases every request and socket. */
export function connectLocalHost({settings,save,origin,authorize,version,onStatus=()=>{}}) {
  const endpoint=validateEndpoint(settings.endpoint),stop=new AbortController();let socket;
  const task=(async()=>{
    let failures=0;
    while(!stop.signal.aborted){
      try{
        onStatus('connecting');
        if(!settings.token){
          if(!/^[a-f0-9]{64}$/.test(settings.pairingKey??''))throw new Error('Pair this environment again in Weft');
          const response=await fetch(endpoint.href+'/pair',{method:'POST',headers:{authorization:`Bearer ${settings.pairingKey}`},redirect:'error',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(20_000)])});
          if(response.status===401||response.status===403){onStatus('pairing-rejected');return;}
          if(!response.ok)throw new Error('Pairing unavailable');
          const result=await response.json();if(result.protocol!==PROTOCOL||!/^[a-f0-9]{64}$/.test(result.token))throw new Error('Invalid pairing response');
          settings={endpoint:endpoint.href,token:result.token};await save(settings);
        }
        const cookie=await authorize();
        const remote=new URL(endpoint.href+'/connect');remote.protocol='wss:';
        socket=new WebSocket(remote,{headers:{authorization:`Bearer ${settings.token}`,'x-weft-protocol':PROTOCOL,'x-dsh-version':version},handshakeTimeout:20_000,maxPayload:MAX_FRAME,followRedirects:false});
        const outcome=await runTunnel(socket,{origin,cookie,signal:stop.signal,onOpen:()=>{failures=0;onStatus('connected');}});
        if(outcome===401||outcome===403){onStatus('revoked');return;}
        if(outcome===409){onStatus('incompatible');return;}
        if(!stop.signal.aborted)onStatus('retrying');
      }catch{if(!stop.signal.aborted)onStatus('retrying');}
      if(!stop.signal.aborted)await wait(Math.min(30_000,500*2**Math.min(failures++,6))*(0.5+Math.random()/2),stop.signal);
    }
  })();
  return async()=>{stop.abort();socket?.terminate();await task;};
}
export function runTunnel(socket,{origin,cookie,signal,onOpen=()=>{}}) {
  const active=new Map(),clients=new Map();let heartbeat,alive=true;
  const send=frame=>{if(socket.readyState!==WebSocket.OPEN)throw new Error('Tunnel unavailable');if(socket.bufferedAmount>32*1024*1024){socket.close(1013,'Relay overloaded');throw new Error('Tunnel overloaded');}socket.send(JSON.stringify(frame));};
  const mux=new MuxChannel(send,async(id,text)=>{
    const local=clients.get(id)?.local;if(!local)throw new Error('Native stream closed');
    const deadline=Date.now()+15_000;
    while(local.readyState===WebSocket.CONNECTING||local.bufferedAmount>1024*1024){if(signal.aborted||Date.now()>deadline||local.readyState>WebSocket.OPEN)throw new Error('Native consumer unavailable');await wait(10,signal);}
    if(local.readyState!==WebSocket.OPEN)throw new Error('Native stream closed');
    await new Promise((resolve,reject)=>local.send(text,error=>error?reject(error):resolve()));
  },(id,error)=>{console.warn('Weft native stream closed:',error.message);clients.get(id)?.local.terminate();try{send({type:'ws-close',id});}catch{}});
  const release=id=>{const state=active.get(id);if(state){active.delete(id);clearTimeout(state.timer);state.abort.abort();state.ack?.();void state.writer?.abort().catch(()=>{});}};
  // Up to WINDOW chunks travel unacknowledged; the relay acknowledges each one as the browser consumes it.
  const credit=state=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Response consumer timed out')),30_000);state.ack=()=>{clearTimeout(timer);resolve();};});
  const sendBody=async(id,body,state)=>{
    const reader=body?.getReader();try{if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;for(let offset=0;offset<chunk.value.length;offset+=CHUNK){
      state.abort.signal.throwIfAborted();
      while(state.inflight>=WINDOW){await credit(state);state.abort.signal.throwIfAborted();}
      while(socket.bufferedAmount>BACKLOG){await wait(10,state.abort.signal);state.abort.signal.throwIfAborted();}
      state.inflight++;send({type:'chunk',id,body:Buffer.from(chunk.value.subarray(offset,offset+CHUNK)).toString('base64')});
    }}}finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
    send({type:'end',id});
  };
  const request=frame=>{
    const {id,method,path}=frame;
    if(active.has(id)||clients.has(id)||active.size+clients.size>=MAX_ACTIVE||!allowed(path)||!['GET','HEAD','POST'].includes(method))throw new Error('Invalid request');
    const abort=new AbortController(),body=new TransformStream(),writer=body.writable.getWriter();
    const state={abort,writer,writes:0,inflight:0,timer:setTimeout(()=>release(id),30_000)};active.set(id,state);
    const headers=new Headers();for(const [key,value] of frame.headers??[])if(headersAllowed.has(key.toLowerCase()))headers.set(key,value);headers.set('cookie',cookie);
    void (async()=>{
      try{
        const response=await fetch(new URL(path,origin),{method,headers,redirect:'manual',signal:abort.signal,...(method==='POST'?{body:body.readable,duplex:'half'}:{})});
        if(response.status===401){await response.body?.cancel();socket.close(1012,'Renew local authentication');throw new Error('Local authentication expired');}
        clearTimeout(state.timer);
        const gzip=response.status===200&&response.body!==null&&!response.headers.has('content-range')&&compressible(response.headers.get('content-type'));
        send({type:'response',id,status:response.status,headers:[...response.headers].filter(([key])=>replyHeaders.has(key)),...(gzip?{encoding:'gzip'}:{})});
        await sendBody(id,gzip?response.body.pipeThrough(new CompressionStream('gzip')):response.body,state);
      }catch{try{send({type:'error',id});}catch{}}
      finally{release(id);}
    })();
  };
  const openClient=id=>{
    if(active.has(id)||clients.has(id)||active.size+clients.size>=MAX_ACTIVE)throw new Error('Connection limit');
    const target=new URL('/api/remote.mux',origin);target.protocol=target.protocol==='https:'?'wss:':'ws:';
    const local=new WebSocket(target,{headers:{cookie},maxPayload:MAX_MUX_BYTES,followRedirects:false,handshakeTimeout:15_000});
    clients.set(id,{local});
    local.on('message',(data,binary)=>{if(binary){local.close(1003);return;}void mux.send(id,data.toString()).catch(()=>{});});
    local.on('error',()=>local.terminate());local.on('close',()=>{clients.delete(id);mux.drop(id);try{send({type:'ws-close',id});}catch{}});
  };
  return new Promise(resolve=>{
    let rejectedStatus;
    const stop=()=>socket.terminate();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    socket.on('open',()=>{onOpen();const ping=()=>{if(!alive)socket.terminate();else{alive=false;socket.send('weft:ping');}};ping();heartbeat=setInterval(ping,20_000);});
    socket.on('unexpected-response',(_request,response)=>{rejectedStatus=response.statusCode;response.resume();socket.terminate();});
    socket.on('message',(data,binary)=>{
      try{
        if(!binary&&data.toString()==='weft:pong'){alive=true;return;}
        if(binary||data.length>MAX_FRAME)throw new Error('Invalid frame');
        const frame=JSON.parse(data.toString());if(typeof frame.id!=='string'||frame.id.length>80)throw new Error('Invalid identity');
        if(mux.handle(frame))return;
        const state=active.get(frame.id);
        if(state){clearTimeout(state.timer);state.timer=setTimeout(()=>{try{send({type:'error',id:frame.id});}catch{}release(frame.id);},30_000);}
        if(frame.type==='request')request(frame);
        else if(frame.type==='ws-open')openClient(frame.id);
        else if(frame.type==='ws-close'){mux.drop(frame.id);clients.get(frame.id)?.local.terminate();}
        else if(frame.type==='cancel')release(frame.id);
        else if(frame.type==='ack'&&state){state.inflight=Math.max(0,state.inflight-1);const ack=state.ack;state.ack=undefined;ack?.();}
        else if(frame.type==='chunk'&&state){
          if(state.writes>=WINDOW||typeof frame.body!=='string'||frame.body.length>CHUNK*4/3+4)throw new Error('Upload overflow');state.writes++;
          void state.writer.write(Buffer.from(frame.body,'base64')).then(()=>{state.writes--;send({type:'ack',id:frame.id});}).catch(()=>release(frame.id));
        }else if(frame.type==='end'&&state){void state.writer.close().catch(()=>{});}
      }catch{socket.close(1008,'Invalid relay frame');}
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{mux.close();clearInterval(heartbeat);signal.removeEventListener('abort',stop);for(const id of active.keys())release(id);for(const client of clients.values())client.local.terminate();clients.clear();resolve(rejectedStatus);});
  });
}
