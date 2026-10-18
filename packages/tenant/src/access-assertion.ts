import {createRemoteJWKSet, customFetch, errors, jwtVerify} from 'jose';
import {principalFromVerifiedAccessIdentity, type Principal} from './index.ts';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AccessAssertionUnavailable extends Error {
  constructor() {super('Cloudflare Access verification keys are temporarily unavailable');}
}

/** Verify Access's signed request assertion when the runtime omits ctx.access.
 * No application Bearer token, identity header, or unsigned cookie is accepted.
 */
export async function authenticateAccessAssertion(
  request: Request, audience: string, teamDomain: string,
): Promise<Principal | undefined> {
  const header = request.headers.get('cf-access-jwt-assertion');
  const cookies = request.headers.get('cookie')?.split(';').map(value => value.trim())
    .filter(value => value.startsWith('CF_Authorization='));
  // Prefer Access's assertion header. Ambiguous same-name cookies are rejected.
  const assertion = header ?? (cookies?.length === 1 ? cookies[0]!.slice('CF_Authorization='.length) : undefined);
  if (!assertion || assertion.length > 16384 || assertion.split('.').length !== 3) return undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i.test(teamDomain)) return undefined;
  const issuer = `https://${teamDomain}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
      timeoutDuration: 5000,
      cacheMaxAge: 600000,
      cooldownDuration: 30000,
      [customFetch]: async (url, options) => {
        try {
          const response = await fetch(url, {...options, redirect: 'manual'});
          if (response.status !== 200) throw new AccessAssertionUnavailable();
          return response;
        } catch {throw new AccessAssertionUnavailable();}
      },
    });
    if (keySets.size >= 8) keySets.delete(keySets.keys().next().value!);
    keySets.set(issuer, keys);
  }
  try {
    const {payload} = await jwtVerify(assertion, keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email'],
    });
    if (payload.common_name !== undefined || payload.service_token_id !== undefined || payload.service_token_uuid !== undefined) return undefined;
    // Subject is Access's immutable user UUID. Keep the same tenant identity as
    // native getIdentity(), regardless of which admission path this request took.
    return await principalFromVerifiedAccessIdentity({sub: payload.sub, email: payload.email}, teamDomain);
  } catch (error) {
    if (error instanceof AccessAssertionUnavailable || error instanceof errors.JWKSTimeout) throw new AccessAssertionUnavailable();
    if (error instanceof errors.JOSEError) return undefined;
    throw new AccessAssertionUnavailable();
  }
}
