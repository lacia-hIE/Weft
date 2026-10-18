import { z } from 'zod';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type Runner from '@deepseek-ai/dsh-cordis-host-runner';
import type { CordisDynamicPluginId, CordisDynamicPackageId, CordisDynamicPluginRunId, ApprovalRequestId } from '@deepseek-ai/dsh-cordis-host-runner/types';
import { DynamicCordisRegistry, type DynamicCordisPlugin, type DynamicCordisPendingRequest } from '@weft/upstream/packages/extensions/cordis-host-runner/src/registry.ts';
import remote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
const packageSchema = z.object({ packageId: z.string(), name: z.string(), purpose: z.string(), hostCode: z.string().max(65536).optional(), clientCode: z.string().max(65536).optional() }).strict();
const pendingSchema = z.object({ agentId: z.string(), pluginId: z.string(), packageId: z.string(), pluginRunId: z.string(), mode: z.enum(['run', 'update']), requiresApproval: z.boolean() }).strict();
const documentSchema = z.object({ version: z.literal(1), plugins: z.array(z.object({ inventory: z.unknown(), packages: z.array(packageSchema).max(100), approved: z.array(z.string()).max(100), future: z.boolean(), pending: z.object({ id: z.string(), value: pendingSchema }).optional() })).max(64) }).strict();
/** Native registry semantics, with durable definitions and authorization. */
export class DurablePluginRegistry extends DynamicCordisRegistry {
    private readonly restoreRuns = new Map<CordisDynamicPluginId, {
        pluginRunId: CordisDynamicPluginRunId;
        packageId: CordisDynamicPackageId;
    }>();
    private recoveredRunId: string | undefined;
    constructor(private readonly storage: DurableObjectStorage, private readonly sessionId: string) {
        super();
        storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_native_plugins (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
        const row = storage.sql.exec<{
            document: string;
        }>('SELECT document FROM weft_native_plugins WHERE id=1').toArray()[0];
        if (!row)
            return;
        const document = documentSchema.parse(JSON.parse(row.document));
        for (const saved of document.plugins) {
            const [inventory] = remote.methods['dynamicCordisRunner/inventory'].result.create().parse([saved.inventory]);
            if (!inventory || inventory.agentId !== sessionId)
                throw new Error('Native plugin owner mismatch');
            const plugin: DynamicCordisPlugin = {
                pluginId: inventory.pluginId, sessionId: SessionId(sessionId),
                packages: new Map(saved.packages.map(pkg => [pkg.packageId as CordisDynamicPackageId, { packageId: pkg.packageId as CordisDynamicPackageId, name: pkg.name, purpose: pkg.purpose, ...(pkg.hostCode === undefined ? {} : { hostCode: pkg.hostCode }), ...(pkg.clientCode === undefined ? {} : { clientCode: pkg.clientCode }) }])),
                approvedClientPackages: new Set(saved.approved as CordisDynamicPackageId[]), clientVersionUpdatesApproved: saved.future,
                ...(inventory.currentPackageId === undefined ? {} : { currentPackageId: inventory.currentPackageId }),
                ...(inventory.nextPackageId === undefined ? {} : { nextPackageId: inventory.nextPackageId }),
                ...(inventory.latestRun === undefined ? {} : { latestRun: inventory.latestRun }),
            };
            this.add(plugin);
            if (inventory.activeRun)
                this.restoreRuns.set(plugin.pluginId, inventory.activeRun);
            if (saved.pending) {
                if (saved.pending.value.agentId !== sessionId || saved.pending.value.pluginId !== plugin.pluginId)
                    throw new Error('Native approval owner mismatch');
                this.armRequest(saved.pending.id as ApprovalRequestId, saved.pending.value as DynamicCordisPendingRequest);
            }
        }
    }
    override mintPluginId(prefix: string): string { return prefix + '-' + crypto.randomUUID(); }
    override mintPackageId(): string { return 'pkg-' + crypto.randomUUID(); }
    override mintPluginRunId(): string { const recovered = this.recoveredRunId; this.recoveredRunId = undefined; return recovered ?? 'run-' + crypto.randomUUID(); }
    override mintApprovalRequestId(): string { return 'approval-' + crypto.randomUUID(); }
    checkpoint(runner: Runner): void {
        const inventory = runner.inventory();
        const plugins = this.all().map(plugin => {
            const id = this.pendingRequestFor(plugin.pluginId);
            const pending = id === undefined ? undefined : this.peekRequest(id);
            return { inventory: inventory.find(row => row.pluginId === plugin.pluginId), packages: [...plugin.packages.values()], approved: [...plugin.approvedClientPackages], future: plugin.clientVersionUpdatesApproved, ...(id && pending ? { pending: { id, value: pending } } : {}) };
        });
        const document = JSON.stringify(documentSchema.parse({ version: 1, plugins }));
        if (new TextEncoder().encode(document).byteLength > 4194304)
            throw new Error('Native plugin definitions exceeded the session limit');
        this.storage.sql.exec('INSERT INTO weft_native_plugins VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', document);
    }
    pendingOwners() {
        return this.all().flatMap(plugin => {
            const id = this.pendingRequestFor(plugin.pluginId);
            return id === undefined ? [] : [{ requestId: id, pluginId: plugin.pluginId }];
        });
    }
    async restore(runner: Runner, agent: Agent): Promise<void> {
        for (const [pluginId, run] of this.restoreRuns) {
            this.restoreRuns.delete(pluginId);
            const plugin = this.get(pluginId)!;
            const definition = plugin.packages.get(run.packageId);
            if (!definition || (definition.clientCode !== undefined && !plugin.clientVersionUpdatesApproved && !plugin.approvedClientPackages.has(run.packageId)))
                continue;
            const saved = { latest: plugin.latestRun, current: plugin.currentPackageId, next: plugin.nextPackageId };
            const requestId = this.pendingRequestFor(pluginId);
            const pending = requestId === undefined ? undefined : this.peekRequest(requestId);
            const sameAttempt = pending?.packageId === run.packageId && pending.pluginRunId === run.pluginRunId;
            // A newer version may still be awaiting approval while the old version
            // runs. Restore the old activation without consuming that authorization.
            if (requestId && pending && !sameAttempt)
                this.claimRequest(requestId);
            this.recoveredRunId = run.pluginRunId;
            try {
                const result = await runner.runHostHalf(agent, pluginId, run.packageId, sameAttempt ? pending.mode : plugin.currentPackageId === run.packageId ? 'run' : 'update', sameAttempt ? requestId! : null, false);
                if (result.ok && !sameAttempt) {
                    if (saved.latest)
                        plugin.latestRun = saved.latest;
                    else
                        delete plugin.latestRun;
                    if (saved.current)
                        plugin.currentPackageId = saved.current;
                    else
                        delete plugin.currentPackageId;
                    if (saved.next)
                        plugin.nextPackageId = saved.next;
                    else
                        delete plugin.nextPackageId;
                }
            }
            finally {
                this.recoveredRunId = undefined;
                if (requestId && pending && !sameAttempt)
                    this.armRequest(requestId, pending);
            }
        }
    }
}
