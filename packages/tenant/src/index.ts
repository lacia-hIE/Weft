import { z } from 'zod';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const scopeSchema = z.object({ tenantId: idSchema, sessionId: idSchema }).strict();
export type SessionScope = z.infer<typeof scopeSchema>;

const credentialsSchema = z.array(z.object({
  token: z.string().min(16), tenantId: idSchema, persona: z.string().max(4000),
}).strict()).min(1);

/** Validation-only credential registry; deployment must supply this as a secret. */
export function authenticate(request: Request, registry: string | undefined): { tenantId: string; persona: string } | undefined {
  if (!registry) return undefined;
  const entries = credentialsSchema.parse(JSON.parse(registry));
  if (new Set(entries.map(entry => entry.token)).size !== entries.length) throw new Error('Duplicate validation credentials');
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice(7);
  const entry = entries.find(candidate => candidate.token === token);
  return entry ? { tenantId: entry.tenantId, persona: entry.persona } : undefined;
}

/** Unambiguous tenant-qualified object identity; session ids alone are never routing keys. */
export function sessionAddress(scope: SessionScope): string {
  return JSON.stringify([scope.tenantId, scope.sessionId]);
}
