import { Context } from '@deepseek-ai/cordis';
import { CordisInspectRegistryService } from '@weft/upstream/packages/extensions/cordis-host-runner/src/inspect-registry.ts';
import remote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import { z } from 'zod';
/** Environment-wide routing index; source and approval authority remain in SessionDO. */
export class NativePluginCatalog {
    constructor(private readonly storage: DurableObjectStorage) {
        storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_native_plugin_catalog (plugin_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, inventory TEXT NOT NULL)');
        storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_native_plugin_requests (kind TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY(kind,request_id))');
        storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_native_plugin_sessions (session_id TEXT PRIMARY KEY)');
        storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_native_plugin_manifest (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
    }
    async sync(sessionId: string, raw: unknown, requests: unknown): Promise<void> {
        const inventory = remote.methods['dynamicCordisRunner/inventory'].result.create().parse(raw);
        const pending = z.array(z.object({ requestId: z.string(), pluginId: z.string() }).strict()).max(64).parse(requests);
        if (inventory.length > 64 || inventory.some(plugin => plugin.agentId !== sessionId))
            throw new Error('Native plugin ownership mismatch');
        if (pending.some(request => !inventory.some(plugin => plugin.pluginId === request.pluginId)))
            throw new Error('Native approval ownership mismatch');
        this.storage.transactionSync(() => {
            this.storage.sql.exec('INSERT OR IGNORE INTO weft_native_plugin_sessions VALUES (?)', sessionId);
            const previous = this.storage.sql.exec<{
                plugin_id: string;
            }>('SELECT plugin_id FROM weft_native_plugin_catalog WHERE session_id=?', sessionId).toArray();
            for (const row of previous)
                if (!inventory.some(plugin => plugin.pluginId === row.plugin_id))
                    this.storage.sql.exec('DELETE FROM weft_native_plugin_catalog WHERE plugin_id=?', row.plugin_id);
            for (const plugin of inventory)
                this.storage.sql.exec('INSERT INTO weft_native_plugin_catalog VALUES (?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET inventory=excluded.inventory', plugin.pluginId, sessionId, JSON.stringify(plugin));
            this.storage.sql.exec("DELETE FROM weft_native_plugin_requests WHERE kind='approval' AND session_id=?", sessionId);
            for (const request of pending)
                this.storage.sql.exec("INSERT INTO weft_native_plugin_requests VALUES ('approval',?,?,NULL)", request.requestId, sessionId);
        });
        await this.storage.sync();
    }
    inventory() {
        const rows = this.storage.sql.exec<{
            inventory: string;
        }>('SELECT inventory FROM weft_native_plugin_catalog ORDER BY rowid').toArray();
        return remote.methods['dynamicCordisRunner/inventory'].result.create().parse(rows.map(row => JSON.parse(row.inventory)));
    }
    owner(kind: 'plugin' | 'approval' | 'inspect', resourceId: string): string | undefined {
        const rows = kind === 'plugin'
            ? this.storage.sql.exec<{
                session_id: string;
            }>('SELECT session_id FROM weft_native_plugin_catalog WHERE plugin_id=?', resourceId)
            : this.storage.sql.exec<{
                session_id: string;
            }>('SELECT session_id FROM weft_native_plugin_requests WHERE kind=? AND request_id=? AND (expires_at IS NULL OR expires_at>?)', kind, resourceId, Date.now());
        return rows.toArray()[0]?.session_id;
    }
    async event(sessionId: string, name: string, args: readonly unknown[]): Promise<void> {
        if (name !== 'cordis/inspect-query')
            return;
        const request = z.object({ requestId: z.string(), agentId: z.string() }).parse(args[0]);
        if (request.agentId !== sessionId)
            throw new Error('Native inspect ownership mismatch');
        this.storage.sql.exec('DELETE FROM weft_native_plugin_requests WHERE expires_at IS NOT NULL AND expires_at<=?', Date.now());
        this.storage.sql.exec("INSERT INTO weft_native_plugin_requests VALUES ('inspect',?,?,?) ON CONFLICT(kind,request_id) DO UPDATE SET session_id=excluded.session_id,expires_at=excluded.expires_at", request.requestId, sessionId, Date.now() + 60000);
        await this.storage.sync();
    }
    manifest(): unknown {
        const row = this.storage.sql.exec<{
            document: string;
        }>('SELECT document FROM weft_native_plugin_manifest WHERE id=1').toArray()[0];
        return row ? JSON.parse(row.document) : [];
    }
    async setManifest(raw: unknown): Promise<void> {
        const { providers } = remote.methods['dynamicCordisRunner/syncInspectManifest'].input({ strict: true }).create().parse({ providers: raw });
        const ctx = new Context();
        try {
            new CordisInspectRegistryService(ctx, 10000).syncClientManifest(providers);
        }
        finally {
            await ctx.fiber.dispose();
        }
        this.storage.sql.exec('INSERT INTO weft_native_plugin_manifest VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', JSON.stringify(providers));
        await this.storage.sync();
    }
    sessions(): string[] { return this.storage.sql.exec<{
        session_id: string;
    }>('SELECT session_id FROM weft_native_plugin_sessions').toArray().map(row => row.session_id); }
}
