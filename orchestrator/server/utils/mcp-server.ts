import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import type { JWTPayload } from 'jose';
import { useAuth, getMcpAuthConfig, MCP_REQUIRED_SCOPES } from './auth';
import type { AuthContext } from './auth-helpers';
import { toText } from './built-in-content';
import { LOCAL_ORIGIN, loadApiTools, registerApiTools } from './mcp-tools';
import { hasAuthorizedApp } from './oauth-apps';

/**
 * The Agentor MCP server (Streamable HTTP at `/mcp`).
 *
 * - Auth: `requireMcpAuth` verifies the OAuth access token (a JWT issued by
 *   better-auth's MCP plugin, audience-bound to the `/mcp` resource) and
 *   answers unauthenticated requests with the RFC 9728 challenge that starts
 *   the client's OAuth flow.
 * - Transport: the SDK's stateless `createMcpHandler` serves both the
 *   2025-era and 2026-07-28 protocol revisions, building one server per request.
 * - Tools: generated from the REST API's OpenAPI spec (see `mcp-tools.ts`) and
 *   bound to the calling user, so a tool can do exactly what that user can do
 *   in the dashboard.
 */

const SERVER_INFO = { name: 'agentor', title: 'Agentor', version: '1.0.0' };
const GUIDE_URI = 'agentor://guide';

/** Where the MCP endpoint fetches the JWKS to verify access tokens: the
 * orchestrator's own listener over loopback, so verification never depends on
 * the public URL being routable from inside the container. */
const LOCAL_JWKS_URL = `${LOCAL_ORIGIN}/api/auth/jwks`;

let instructionsPromise: Promise<string> | null = null;

function loadInstructions(): Promise<string> {
  instructionsPromise ??= useStorage('assets:mcp').getItem('instructions.md').then((raw) => toText(raw ?? ''));
  return instructionsPromise;
}

async function createAgentorMcpServer(auth: AuthContext): Promise<McpServer> {
  const [instructions, tools] = await Promise.all([loadInstructions(), loadApiTools()]);
  const server = new McpServer(SERVER_INFO, { instructions });
  registerApiTools(server, tools, auth);
  // The same guide as the `instructions`, for clients that surface resources
  // but not server instructions.
  server.registerResource(
    'agentor-guide',
    GUIDE_URI,
    { title: 'Agentor guide', description: 'What Agentor is and how to use its tools', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: instructions }] }),
  );
  return server;
}

function tokenClientId(claims: JWTPayload): string {
  return String(claims.client_id ?? claims.azp ?? '');
}

/** Resolves the verified token to the Agentor user it acts for. Access tokens
 * are stateless JWTs that outlive account changes, so the user and the user's
 * authorization of the client are re-checked on every request: deleted or
 * banned users and revoked applications lose MCP access immediately. */
async function resolveTokenUser(claims: JWTPayload): Promise<AuthContext | null> {
  if (!claims.sub) return null;
  const ctx = await useAuth().$context;
  const user = await ctx.internalAdapter.findUserById(claims.sub);
  if (!user || user.banned) return null;
  if (!(await hasAuthorizedApp(user.id, tokenClientId(claims)))) return null;
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role ?? null } };
}

/** RFC 6750 `invalid_token` challenge (with the RFC 9728 metadata pointer) for
 * a token that verified but no longer grants access — clients re-authorize. */
function revokedTokenResponse(resource: string): Response {
  const url = new URL(resource);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  const message = 'Access revoked: the user no longer exists or no longer authorizes this application';
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer error="invalid_token", error_description="${message}", resource_metadata="${metadata}"`,
    },
  });
}

function buildMcpRequestHandler(): (request: Request) => Promise<Response> {
  const mcpConfig = getMcpAuthConfig();
  const mcpHandler = createMcpHandler(async (ctx) => {
    const auth = ctx.authInfo?.extra?.agentor as AuthContext | undefined;
    if (!auth) throw new Error('MCP request reached the server factory without an authenticated user');
    return createAgentorMcpServer(auth);
  }, {
    onerror: (err) => useLogger().warn(`[mcp] ${err.message}`),
  });

  return requireMcpAuth(
    useAuth(),
    async (request, claims) => {
      const auth = await resolveTokenUser(claims);
      if (!auth) return revokedTokenResponse(mcpConfig.resource!);
      const token = request.headers.get('authorization')?.replace(/^\S+\s+/, '') ?? '';
      const authInfo: AuthInfo = {
        token,
        clientId: tokenClientId(claims),
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
        expiresAt: claims.exp,
        extra: { agentor: auth },
      };
      return mcpHandler.fetch(request, { authInfo });
    },
    { resource: mcpConfig.resource, requiredScopes: MCP_REQUIRED_SCOPES, jwksUrl: LOCAL_JWKS_URL },
  );
}

let requestHandler: ((request: Request) => Promise<Response>) | null = null;

/** The authenticated MCP request handler (web-standard Request → Response). */
export function useMcpRequestHandler(): (request: Request) => Promise<Response> {
  requestHandler ??= buildMcpRequestHandler();
  return requestHandler;
}
