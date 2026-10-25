// Opaque native messages are fragmented only on the private device carrier.
// The browser and DSH keep their original Remote Mux protocol.
export const MAX_MUX_BYTES=8*1024*1024;
const CHUNK=32*1024;
const encode=bytes=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);};
const decode=value=>{
  if(typeof value!=='string'||value.length>CHUNK*4/3+4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid fragment');
  return Uint8Array.from(atob(value),value=>value.charCodeAt(0));
};
export class MuxChannel {
  constructor(send,deliver,failed,{timeoutMs=30_000,maxBufferedBytes=16*1024*1024,maxMessageBytes=MAX_MUX_BYTES}={}) {
    this.sendFrame=send;this.deliver=deliver;this.failed=failed;this.timeoutMs=timeoutMs;this.maxBufferedBytes=maxBufferedBytes;this.maxMessageBytes=maxMessageBytes;
    this.outgoing=new Map();this.incoming=new Map();this.buffered=0;this.closed=false;
  }
  reserve(size){if(this.buffered+size>this.maxBufferedBytes)throw new Error('Mux buffer limit');this.buffered+=size;}
  timer(id){return setTimeout(()=>this.drop(id,new Error('Mux stream timed out')),this.timeoutMs);}
  send(id,text){
    if(this.closed)return Promise.reject(new Error('Mux closed'));
    return new Promise((resolve,reject)=>{
      try{
        const bytes=new TextEncoder().encode(text);
        if(bytes.length>this.maxMessageBytes)throw new Error('Native message limit');
        const queue=this.outgoing.get(id)??[];
        if(queue.length>=32||(!this.outgoing.has(id)&&this.outgoing.size>=64))throw new Error('Mux queue limit');
        this.reserve(bytes.length);
        const state={bytes,message:crypto.randomUUID(),seq:0,offset:0,resolve,reject,timer:undefined};queue.push(state);this.outgoing.set(id,queue);
        if(queue.length===1)this.next(id);
      }catch(error){reject(error);this.drop(id,error);}
    });
  }
  next(id){
    const state=this.outgoing.get(id)?.[0];if(!state)return;
    try{
      clearTimeout(state.timer);state.timer=this.timer(id);
      const end=Math.min(state.offset+CHUNK,state.bytes.length);
      this.sendFrame({type:'ws-fragment',id,message:state.message,seq:state.seq,body:encode(state.bytes.subarray(state.offset,end)),end:end===state.bytes.length});
    }catch(error){this.drop(id,error);}
  }
  handle(frame){
    if(!['ws-fragment','ws-fragment-ack'].includes(frame.type))return false;
    if(this.closed)return true;
    const {id}=frame;
    try{
      if(typeof id!=='string'||id.length>80||typeof frame.message!=='string'||frame.message.length>80||!Number.isSafeInteger(frame.seq)||frame.seq<0)throw new Error('Invalid fragment identity');
      if(frame.type==='ws-fragment-ack'){
        const queue=this.outgoing.get(id),state=queue?.[0];
        if(!state)return true; // A closed stream may have a late acknowledgement.
        if(frame.message!==state.message||frame.seq!==state.seq)throw new Error('Invalid fragment acknowledgement');
        clearTimeout(state.timer);state.offset=Math.min(state.offset+CHUNK,state.bytes.length);state.seq++;
        if(state.offset===state.bytes.length){queue.shift();this.buffered-=state.bytes.length;state.resolve();if(!queue.length)this.outgoing.delete(id);}
        queueMicrotask(()=>this.next(id));return true;
      }
      let state=this.incoming.get(id);
      if(!state){if(frame.seq!==0||this.incoming.size>=64)throw new Error('Missing fragment start');state={message:frame.message,seq:0,size:0,chunks:[],timer:undefined,delivering:false};this.incoming.set(id,state);}
      if(state.delivering||state.message!==frame.message||state.seq!==frame.seq||typeof frame.end!=='boolean')throw new Error('Fragment sequence mismatch');
      const bytes=decode(frame.body);
      if(!frame.end&&bytes.length!==CHUNK)throw new Error('Incomplete fragment');
      if(state.size+bytes.length>this.maxMessageBytes)throw new Error('Native message limit');
      this.reserve(bytes.length);state.size+=bytes.length;state.chunks.push(bytes);state.seq++;
      clearTimeout(state.timer);state.timer=this.timer(id);
      const acknowledge=()=>this.sendFrame({type:'ws-fragment-ack',id,message:frame.message,seq:frame.seq});
      if(!frame.end){acknowledge();return true;}
      state.delivering=true;
      const joined=new Uint8Array(state.size);let offset=0;for(const chunk of state.chunks){joined.set(chunk,offset);offset+=chunk.length;}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(joined);
      void Promise.resolve().then(()=>{if(this.incoming.get(id)===state)return this.deliver(id,text);}).then(()=>{
        if(this.incoming.get(id)!==state)return;
        clearTimeout(state.timer);this.buffered-=state.size;this.incoming.delete(id);acknowledge();
      }).catch(error=>this.drop(id,error));
    }catch(error){this.drop(id,error);}
    return true;
  }
  drop(id,error){
    const outgoing=this.outgoing.get(id);this.outgoing.delete(id);
    for(const state of outgoing??[]){clearTimeout(state.timer);this.buffered-=state.bytes.length;state.reject(error??new Error('Mux stream closed'));}
    const incoming=this.incoming.get(id);this.incoming.delete(id);
    if(incoming){clearTimeout(incoming.timer);this.buffered-=incoming.size;}
    if(error)this.failed(id,error);
  }
  close(){this.closed=true;for(const id of new Set([...this.outgoing.keys(),...this.incoming.keys()]))this.drop(id);}
}
