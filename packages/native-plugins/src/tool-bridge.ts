import type {Context} from '@deepseek-ai/cordis';
import {HarnessError, type ContentBlock} from '@deepseek-ai/dsh-llm';
import type {JsonValue} from '@deepseek-ai/dsh-util-values';
import type {ToolExecutionResult} from '@deepseek-ai/dsh-tools';
import {z} from 'zod';

export const toolDescriptions = z.array(z.object({name:z.string().min(1).max(100),description:z.string(),parameters:z.record(z.string(),z.unknown()),outputSchema:z.record(z.string(),z.unknown()),hasPresentation:z.boolean(),timeoutMs:z.number().positive().optional()})).max(100);
export type ToolDescription = z.infer<typeof toolDescriptions>[number];
export interface ToolTransport {
  execute(name:string,args:unknown,callId:string,operationId:string):Promise<ToolExecutionResult>;
  cancel(operationId:string):Promise<void>;
  waitUntil(work:Promise<unknown>):void;
}
/** Tool policy, schema validation and projections remain owned by the calling Agent. */
export function registerRemoteTool(ctx:Context, tool:ToolDescription, transport:ToolTransport):()=>void {
  const projections = new WeakMap<object,{content:ContentBlock[];meta?:JsonValue}>();
  return ctx.tools.register({name:tool.name,description:tool.description,parameters:tool.parameters,
    ...(tool.timeoutMs===undefined?{}:{timeoutMs:tool.timeoutMs}),output:{schema:tool.outputSchema,
      render:args=>{const value=projections.get(args as object);if(!value)throw new Error('Missing isolated tool result projection');return value.content;},
      ...(tool.hasPresentation?{presentationMeta:(args:unknown)=>projections.get(args as object)?.meta??null}:{}),
    },execute:async(args,exec)=>{
      exec.signal.throwIfAborted();const operationId=crypto.randomUUID();
      const abort=()=>transport.waitUntil(transport.cancel(operationId).catch(()=>{}));
      exec.signal.addEventListener('abort',abort,{once:true});
      try {
        const result=await transport.execute(tool.name,args,exec.callId,operationId);exec.signal.throwIfAborted();
        for(const context of result.additionalContexts??[])exec.deferContext(context);
        if(result.isError)throw new HarnessError(result.error.message,result.error.info?.code??'PLUGIN_TOOL_FAILED');
        if(result.concludesTurn)exec.concludeTurn();projections.set(args as object,result);return result.value;
      } finally {exec.signal.removeEventListener('abort',abort);}
    }});
}
