import { randomBytes } from 'node:crypto';
import type { AuthContext } from './auth-helpers';

/**
 * Single-use internal auth capabilities.
 *
 * The MCP server executes every tool by re-dispatching to the matching REST
 * route over loopback HTTP (`LOCAL_ORIGIN`), so all route validation and
 * ownership checks are reused verbatim. The MCP caller authenticated with an
 * OAuth access token bound to the `/mcp` resource (possibly DPoP-bound, so it
 * cannot simply be forwarded). Instead, the MCP layer mints a random token
 * that maps to the already-verified `AuthContext`, sends it in
 * `INTERNAL_AUTH_HEADER`, and the auth middleware redeems it exactly once.
 * Tokens only ever travel over the container's loopback interface, are
 * redeemable once, and expire after `TOKEN_TTL_MS`.
 */
export const INTERNAL_AUTH_HEADER = 'x-agentor-internal-auth';
const TOKEN_TTL_MS = 60_000;

const grants = new Map<string, { auth: AuthContext; expiresAt: number }>();

function sweepExpired(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
}

export function issueInternalAuthToken(auth: AuthContext): string {
  const now = Date.now();
  sweepExpired(now);
  const token = randomBytes(32).toString('base64url');
  grants.set(token, { auth, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/** Redeems a token (single use). Returns null for unknown or expired tokens. */
export function consumeInternalAuthToken(token: string | null | undefined): AuthContext | null {
  if (!token) return null;
  const grant = grants.get(token);
  if (!grant) return null;
  grants.delete(token);
  return grant.expiresAt > Date.now() ? grant.auth : null;
}
