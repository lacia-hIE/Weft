import {DurableObject} from 'cloudflare:workers';

/** Dedicated offline compiler. No workspace, model, registry or R2 credentials enter this container. */
export class PluginBuilderDO extends DurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  build(input: string): Promise<Response> {
    const next = this.tail.catch(() => {}).then(async () => {
      if(await this.ctx.storage.get('retired'))throw new Error('Environment builder is stopped');
      if (input.length > 18 * 1024 * 1024) throw new Error('Build input too large');
      const container = this.ctx.container;
      if (!container) throw new Error('Plugin builder container is unavailable');
      let secret = await this.ctx.storage.get<string>('build-secret');
      if (!container.running || !secret) {
        secret = crypto.randomUUID(); await this.ctx.storage.put('build-secret', secret);
        if (container.running) await container.destroy();
        container.start({env: {BUILD_SECRET: secret}, enableInternet: false});
      }
      await container.setInactivityTimeout(60_000);
      const port = container.getTcpPort(8080), headers = {authorization: `Bearer ${secret}`};
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {const response = await port.fetch('http://builder/health', {headers, signal: AbortSignal.timeout(1000)}); await response.body?.cancel(); if (response.ok) {ready = true; break;}}
        catch { /* The image is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error('Plugin builder did not become ready');
      return port.fetch('http://builder/build', {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: input, signal: AbortSignal.timeout(60_000)});
    });
    this.tail = next;
    return next;
  }
  retire(operation:number):Promise<void> {
    const pending=this.tail.catch(()=>{}).then(async()=>{
      const old=await this.ctx.storage.get<number>('lifecycle-revision');if(old && old>operation)throw new Error('Stale builder operation');
      await this.ctx.storage.put({'retired':operation,'lifecycle-revision':operation});
      if(this.ctx.container?.running)await this.ctx.container.destroy();
      await this.ctx.storage.delete('build-secret');
    });this.tail=pending;return pending;
  }
  activate(operation:number):Promise<void> {
    const pending=this.tail.catch(()=>{}).then(async()=>{
      const old=await this.ctx.storage.get<number>('lifecycle-revision');if(old && old>operation)throw new Error('Stale builder operation');
      await this.ctx.storage.put('lifecycle-revision',operation);await this.ctx.storage.delete('retired');
    });this.tail=pending;return pending;
  }
}
