import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const agentSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    persona: z.string().max(4000),
    workspaceId: id,
    plugins: z
      .array(z.object({ id, config: z.record(z.string(), z.json()) }).strict())
      // The official standard preset composes 21 rows.
      .max(32),
    allowClientPlugins: z.boolean(),
    disabled: z.boolean().optional(),
    model: z
      .object({
        provider: z.literal("deepseek"),
        name: z.string().trim().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();
// Keep public RPC contracts finite: recursively inferred z.json types overwhelm
// DurableObjectStub's serializability projection. Runtime schemas remain strict.
export interface AgentSpec {
  id: string;
  name: string;
  persona: string;
  workspaceId: string;
  plugins: { id: string; config: Record<string, unknown> }[];
  allowClientPlugins: boolean;
  disabled?: boolean | undefined;
  model?: { provider: "deepseek"; name: string } | undefined;
}
export interface AgentRevision {
  spec: AgentSpec;
  revision: number;
  publishedAt: string;
  upstream: string;
}
export interface SessionRecord {
  id: string;
  title: string;
  agentId: string;
  revision: number;
  workspaceId: string;
  updatedAt: string;
}
export const clientPluginSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    source: z.string().min(1).max(100_000),
    config: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export interface ClientPluginInput {
  id: string;
  name: string;
  source: string;
  config: Record<string, unknown>;
}
export interface ClientPlugin extends ClientPluginInput {
  revision: string;
  enabled: boolean;
  publishedAt: string;
}
export interface TenantState {
  agents: AgentRevision[];
  sessions: SessionRecord[];
  clientPlugins: ClientPlugin[];
}

export const environmentScopeSchema = z
  .object({ tenantId: id, environmentId: id })
  .strict();
export type EnvironmentScope = z.infer<typeof environmentScopeSchema>;
export type ControlScope = EnvironmentScope;
export const environmentCreateSchema = z
  .object({ id: id.optional(), name: z.string().trim().min(1).max(80) })
  .strict();
export interface EnvironmentRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
