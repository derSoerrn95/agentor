import { useAuth } from '../../utils/auth';

/**
 * OAuth discovery documents that MCP clients fetch from the root of the
 * origin: RFC 9728 protected-resource metadata
 * (`/.well-known/oauth-protected-resource[/mcp]`) and RFC 8414 issuer-inserted
 * authorization-server metadata (`/.well-known/oauth-authorization-server/api/auth`).
 * better-auth's MCP / OAuth provider plugins answer them from `auth.handler`;
 * everything they don't recognise falls through to its 404.
 */
export default defineEventHandler((event) => {
  return useAuth().handler(toWebRequest(event));
});
