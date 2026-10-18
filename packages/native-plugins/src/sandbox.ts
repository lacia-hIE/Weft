import { parse } from 'acorn';
import type { Context } from '@deepseek-ai/cordis';
import type { NativePluginPlatform } from './platform.ts';
import type { DurablePluginRegistry } from './registry.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        weftNativePluginRegistry: DurablePluginRegistry;
        weftNativePluginPlatform: NativePluginPlatform;
    }
}
interface Sandbox {
    ctx: Context;
    pluginId: string;
    runId: string;
    handle: (method: unknown, fn: unknown) => () => void;
}
export function precheckCode(code: string, half: string): void {
    if (new TextEncoder().encode(code).byteLength > 65536)
        throw new Error(half + ' exceeds 64 KiB');
    try {
        parse(`async function plugin(harness){\n${code}\n}`, { ecmaVersion: 'latest', sourceType: 'module' });
    }
    catch {
        throw new Error(half + ' must be a valid JavaScript async function body');
    }
}
export function createSandbox(ctx: Context, pluginId: string, runId: string, extras: {
    handle: Sandbox['handle'];
}): Sandbox { return { ctx, pluginId, runId, handle: extras.handle }; }
export function evaluateHostCode(sandbox: Sandbox, code: string, _pluginId: string, _timeoutMs: number) {
    return sandbox.ctx.weftNativePluginPlatform.evaluate(sandbox.ctx, sandbox.pluginId, sandbox.runId, code, sandbox.handle);
}
