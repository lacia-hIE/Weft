import { z } from 'zod';
import { DATA_LAYOUT_VERSION } from './layout.ts';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const scopeSchema = z.object({ tenantId: idSchema, sessionId: idSchema, environmentId: idSchema.optional() }).strict();
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
  return principalFromVerifiedAccessIdentity(await access.getIdentity(), teamDomain);
}

/** The caller must establish authenticity before using these identity claims. */
export async function principalFromVerifiedAccessIdentity(
  identity: unknown, teamDomain: string,
): Promise<Principal | undefined> {
  const parsed = identitySchema.safeParse(identity);
  if (!parsed.success) return undefined;
  const userId = parsed.data.user_uuid ?? parsed.data.sub;
  if (!userId) return undefined; // Service credentials are not user identities.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([teamDomain, userId])));
  const tenantId = 'user-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { userId, email: parsed.data.email, tenantId };
}

/** Unambiguous tenant-qualified object identity; session ids alone are never routing keys. */
export function sessionAddress(scope: SessionScope): string {
  return JSON.stringify([DATA_LAYOUT_VERSION, 'session', scope.tenantId, scope.environmentId ?? 'default', scope.sessionId]);
}
