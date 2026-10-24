import WebSocket from 'ws';
const PROTOCOL='weft-local-host/1',CHUNK=32*1024,MAX_FRAME=128*1024,MAX_ACTIVE=64;
const allowed=path=>typeof path==='string'&&path.startsWith('/')&&!path.startsWith('//')&&!/[\\\r\n\0]/.test(path)&&!/%(?:2f|5c|2e)/i.test(path)&&!path.split(/[/?#]/).includes('..')&&(path==='/'||path.startsWith('/api/')||path.startsWith('/plugins/')||path.startsWith('/assets/'));
const headersAllowed=new Set(['content-type','accept','range','if-none-match','if-modified-since']);
const replyHeaders=new Set(['content-type','content-disposition','etag','last-modified','accept-ranges','content-range']);
const wait=(ms,signal)=>new Promise(resolve=>{const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();};const timer=setTimeout(stop,ms);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
function validateEndpoint(value){
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
        if(!settings.token){
          if(!/^[a-f0-9]{64}$/.test(settings.pairingKey??''))throw new Error('Pair this environment again in Weft');
          const response=await fetch(endpoint.href+'/pair',{method:'POST',headers:{authorization:`Bearer ${settings.pairingKey}`},redirect:'error',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(20_000)])});
          if(response.status===401||response.status===403){onStatus('pairing rejected; create a new connection file');return;}
          if(!response.ok)throw new Error('Pairing unavailable');
          const result=await response.json();if(result.protocol!==PROTOCOL||!/^[a-f0-9]{64}$/.test(result.token))throw new Error('Invalid pairing response');
          settings={endpoint:endpoint.href,token:result.token};await save(settings);
        }
        const cookie=await authorize();
        const remote=new URL(endpoint.href+'/connect');remote.protocol='wss:';
        socket=new WebSocket(remote,{headers:{authorization:`Bearer ${settings.token}`,'x-weft-protocol':PROTOCOL,'x-dsh-version':version},handshakeTimeout:20_000,maxPayload:MAX_FRAME,followRedirects:false});
        const outcome=await runTunnel(socket,{origin,cookie,signal:stop.signal,onOpen:()=>{failures=0;onStatus('connected');}});
        if(outcome===401||outcome===403||outcome===409){onStatus('connection revoked or version incompatible; pair again in Weft');return;}
      }catch{if(!stop.signal.aborted)onStatus('disconnected; retrying');}
      if(!stop.signal.aborted)await wait(Math.min(30_000,500*2**Math.min(failures++,6))*(0.5+Math.random()/2),stop.signal);
    }
  })();
  return async()=>{stop.abort();socket?.terminate();await task;};
}
export function runTunnel(socket,{origin,cookie,signal,onOpen=()=>{}}) {
  const active=new Map(),clients=new Map();let heartbeat;
  const send=frame=>{if(socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>1024*1024)throw new Error('Tunnel unavailable');socket.send(JSON.stringify(frame));};
  const release=id=>{const state=active.get(id);if(state){active.delete(id);clearTimeout(state.timer);state.abort.abort();state.ack?.();void state.writer?.abort().catch(()=>{});}};
  const sendBody=async(id,body,state)=>{
    const reader=body?.getReader();try{if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;for(let offset=0;offset<chunk.value.length;offset+=CHUNK){
      state.abort.signal.throwIfAborted();
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Response consumer timed out')),30_000);state.ack=()=>{clearTimeout(timer);resolve();};send({type:'chunk',id,body:Buffer.from(chunk.value.subarray(offset,offset+CHUNK)).toString('base64')});});
    }}}finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
    send({type:'end',id});
  };
  const request=frame=>{
    const {id,method,path}=frame;
    if(active.has(id)||clients.has(id)||active.size+clients.size>=MAX_ACTIVE||!allowed(path)||!['GET','HEAD','POST'].includes(method))throw new Error('Invalid request');
    const abort=new AbortController(),body=new TransformStream(),writer=body.writable.getWriter();
    const state={abort,writer,writing:false,timer:setTimeout(()=>release(id),30_000)};active.set(id,state);
    const headers=new Headers();for(const [key,value] of frame.headers??[])if(headersAllowed.has(key.toLowerCase()))headers.set(key,value);headers.set('cookie',cookie);
    void (async()=>{
      try{
        const response=await fetch(new URL(path,origin),{method,headers,redirect:'manual',signal:abort.signal,...(method==='POST'?{body:body.readable,duplex:'half'}:{})});
        clearTimeout(state.timer);
        send({type:'response',id,status:response.status,headers:[...response.headers].filter(([key])=>replyHeaders.has(key))});
        await sendBody(id,response.body,state);
      }catch{try{send({type:'error',id});}catch{}}
      finally{release(id);}
    })();
  };
  const openClient=id=>{
    if(active.has(id)||clients.has(id)||active.size+clients.size>=MAX_ACTIVE)throw new Error('Connection limit');
    const target=new URL('/api/remote.mux',origin);target.protocol=target.protocol==='https:'?'wss:':'ws:';
    const local=new WebSocket(target,{headers:{cookie},maxPayload:MAX_FRAME,followRedirects:false,handshakeTimeout:15_000});
    const state={local,queue:[],size:0};clients.set(id,state);
    local.on('open',()=>{for(const text of state.queue)local.send(text);state.queue=[];state.size=0;});
    local.on('message',(data,binary)=>{if(binary){local.close(1003);return;}try{send({type:'ws-data',id,text:data.toString()});}catch{local.terminate();}});
    local.on('error',()=>local.terminate());local.on('close',()=>{clients.delete(id);try{send({type:'ws-close',id});}catch{}});
  };
  return new Promise(resolve=>{
    let rejectedStatus;
    const stop=()=>socket.terminate();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    socket.on('open',()=>{onOpen();let alive=true;socket.on('pong',()=>{alive=true;});heartbeat=setInterval(()=>{if(!alive)socket.terminate();else{alive=false;socket.ping();}},20_000);});
    socket.on('unexpected-response',(_request,response)=>{rejectedStatus=response.statusCode;response.resume();socket.terminate();});
    socket.on('message',(data,binary)=>{
      try{
        if(binary||data.length>MAX_FRAME)throw new Error('Invalid frame');
        const frame=JSON.parse(data.toString());if(typeof frame.id!=='string'||frame.id.length>80)throw new Error('Invalid identity');
        const state=active.get(frame.id);
        if(frame.type==='request')request(frame);
        else if(frame.type==='ws-open')openClient(frame.id);
        else if(frame.type==='ws-data'){
          const client=clients.get(frame.id);if(!client)return;if(typeof frame.text!=='string'||frame.text.length>64*1024)throw new Error('Invalid socket data');
          if(client.local.readyState===WebSocket.OPEN){if(client.local.bufferedAmount>1024*1024){client.local.terminate();return;}client.local.send(frame.text);}
          else {client.size+=frame.text.length;if(client.size>1024*1024)throw new Error('Socket overflow');client.queue.push(frame.text);}
        }else if(frame.type==='ws-close')clients.get(frame.id)?.local.terminate();
        else if(frame.type==='cancel')release(frame.id);
        else if(frame.type==='ack'&&state){const ack=state.ack;state.ack=undefined;ack?.();}
        else if(frame.type==='chunk'&&state){
          if(state.writing||typeof frame.body!=='string'||frame.body.length>CHUNK*4/3+4)throw new Error('Upload overflow');state.writing=true;
          void state.writer.write(Buffer.from(frame.body,'base64')).then(()=>{state.writing=false;send({type:'ack',id:frame.id});}).catch(()=>release(frame.id));
        }else if(frame.type==='end'&&state){void state.writer.close().catch(()=>{});}
      }catch{socket.close(1008,'Invalid relay frame');}
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{clearInterval(heartbeat);signal.removeEventListener('abort',stop);for(const id of active.keys())release(id);for(const client of clients.values())client.local.terminate();clients.clear();resolve(rejectedStatus);});
  });
}
