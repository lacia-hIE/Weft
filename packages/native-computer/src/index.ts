import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {javascriptRequest, type JavaScriptRequest, type JavaScriptStatus, type JavaScriptList} from '../../workspace/src/javascript.ts';
import type {WorkspaceScope} from '../../workspace/src/protocol.ts';

export interface JavaScriptTransport {
  javascript(scope: WorkspaceScope, owner: string, request: JavaScriptRequest): Promise<Response>;
  revokeJavaScriptWrites(scope: WorkspaceScope, owner: string): Promise<void>;
}

/** Native tool registration also makes the operations available through PTC's generated tools SDK. */
export function mountComputerJavaScript(ctx: Context, scope: WorkspaceScope, transport: JavaScriptTransport, options: {defaultTimeoutMs: number; allowWritable: boolean} = {defaultTimeoutMs: 120000, allowWritable: true}): void {
  const call = async (owner: string, request: JavaScriptRequest) => {
    const response = await transport.javascript(scope, owner, request);
    if (!response.ok) throw new Error('JavaScript task request failed');
    return await response.json() as JavaScriptStatus | JavaScriptList;
  };
  ctx.tools.register(defineTool({
    name: 'javascript_task',
    description: 'Start or manage a durable JavaScript task in a Worker without a container. Use list to discover this Session\'s tasks after reconnecting, status to query, cancel or cancelAll to stop. Source must be an ES module exporting a default function(input). Read workspace files with node:fs/promises. Network access is disabled. Tasks replay after host restarts. Default access is read-only. writable follows the calling Session sandbox and its original project root; changing the Session to read-only cancels writable tasks. For a durable approval checkpoint import {request} from "ws:approval" and await request("reason"); it returns {approved} without widening file access. Use approve with the exact pending callId to ask the user through the native approval UI. Approval expires after one hour; tasks and output expire after 24 hours. Retained output/results are bounded and outputTruncated reports truncation; save large results to workspace files. A task may outlive this Agent turn. Use run_code for normal tool orchestration; run_code can call this tool through tools.javascript_task.',
    parameters: {
      operation: {type: 'string', enum: ['start', 'list', 'status', 'approve', 'cancel', 'cancelAll'], required: true},
      source: {type: 'string'}, input: {type: 'json'}, id: {type: 'string'}, callId: {type: 'string'},
      writable: {type: 'boolean'}, timeoutMs: {type: 'number'},
    },
    output: {schema: {type: 'json'}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
    execute: async (args, exec) => {
      const agent = exec.agent;
      if (!agent) throw new Error('A Session Agent is required');
      const owner = agent.id;
      let request: JavaScriptRequest;
      if (args.operation === 'approve') {
        if (!args.id || !args.callId) throw new Error('Task id and pending callId are required');
        const state = await call(owner, {operation: 'status', id: args.id});
        if ('tasks' in state) throw new Error('Invalid task status');
        const pending = state.pending.find(call => call.callId === args.callId);
        if (!pending) throw new Error('JavaScript approval is no longer waiting');
        const outcome = await ctx.approval.request({agent, toolName: 'javascript_task', callId: exec.callId, reason: pending.reason, signal: exec.signal});
        request = {operation: 'answer', id: args.id, callId: args.callId, approved: outcome === 'allowed-once'};
      } else if (args.operation === 'start') {
        if (args.writable && !options.allowWritable) throw new Error('Writable JavaScript tasks are disabled in this environment');
        const policy = ctx.sandboxPolicy.resolve({session: agent.session});
        if (args.writable) {
          if (policy.mode === 'read-only') throw new Error('Writable JavaScript tasks are forbidden by the read-only sandbox');
        }
        request = javascriptRequest.parse({operation: 'start', source: args.source, ...(args.input === undefined ? {} : {input: args.input}), cwd: ctx.workingDirectory.get(agent.session), root: policy.mode === 'danger-full-access' ? '/workspace' : policy.workspaceRoot, writable: args.writable ?? false, timeoutMs: args.timeoutMs ?? options.defaultTimeoutMs});
      } else request = javascriptRequest.parse({operation: args.operation, ...(['list', 'cancelAll'].includes(args.operation) ? {} : {id: args.id})});
      exec.signal.throwIfAborted();
      return {...await call(owner, request)};
    },
  }));
}
