import { z } from 'zod';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const scopeSchema = z.object({ tenantId: idSchema, sessionId: idSchema }).strict();
export type SessionScope = z.infer<typeof scopeSchema>;

/** Supplied by the runtime, never reconstructed from caller-controlled headers. */
export interface AccessContext {
  readonly aud: string;
  getIdentity(): Promise<Record<string, unknown> | undefined>;
}

export interface Principal {
  userId: string;
  email: string;
  tenantId: string;
}

const identitySchema = z.object({
  email: z.email(),
  user_uuid: z.string().min(1).max(256).optional(),
  sub: z.string().min(1).max(256).optional(),
});

/** Personal tenants are scoped to the Access organization and immutable user ID. */
export async function authenticateAccess(
  access: AccessContext | undefined, audience: string | undefined, teamDomain: string | undefined,
): Promise<Principal | undefined> {
  if (!access || !audience || !teamDomain || access.aud !== audience) return undefined;
  const parsed = identitySchema.safeParse(await access.getIdentity());
  if (!parsed.success) return undefined;
  const userId = parsed.data.user_uuid ?? parsed.data.sub;
  if (!userId) return undefined; // Service credentials are not user identities.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([teamDomain, userId])));
  const tenantId = 'user-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { userId, email: parsed.data.email, tenantId };
}

/** Unambiguous tenant-qualified object identity; session ids alone are never routing keys. */
export function sessionAddress(scope: SessionScope): string {
  return JSON.stringify([scope.tenantId, scope.sessionId]);
}
