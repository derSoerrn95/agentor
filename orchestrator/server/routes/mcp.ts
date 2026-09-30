import { getMcpAuthConfig } from '../utils/auth';
import { useMcpRequestHandler } from '../utils/mcp-server';

/**
 * MCP endpoint (Streamable HTTP). Authenticated with OAuth access tokens —
 * see `utils/mcp-server.ts`. Lives outside `/api/`, so the session auth
 * middleware does not apply.
 */
export default defineEventHandler(async (event) => {
  const mcpConfig = getMcpAuthConfig();
  if (!mcpConfig.enabled) {
    throw createError({ statusCode: 404, statusMessage: `MCP is disabled: ${mcpConfig.disabledReason}` });
  }
  const request = toWebRequest(event);
  // Behind Traefik the request reaches us as plain http on an internal host,
  // but DPoP proofs and the token audience are bound to the public URL — so
  // the handler must see the canonical resource URL, not the wire URL.
  const url = new URL(request.url);
  const canonical = new Request(new URL(url.search, mcpConfig.resource), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // @ts-expect-error `duplex` is required by Node's fetch for streamed bodies but missing from the DOM RequestInit type
    duplex: 'half',
  });
  return useMcpRequestHandler()(canonical);
});
