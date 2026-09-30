import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
export const MCP_URL = `${BASE_URL}/mcp`;
/** Loopback redirect URI of the test OAuth client. Nothing listens on it — the
 * helpers read the authorization code straight from the consent redirect. */
export const REDIRECT_URI = 'http://127.0.0.1:53682/callback';

/**
 * OAuth client state for one MCP "installation", driven by the MCP SDK's own
 * OAuth machinery (RFC 9728 discovery, dynamic client registration, PKCE,
 * token exchange) — the same code path real MCP clients use.
 */
export class TestOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private info?: StoredOAuthClientInformation;
  private storedTokens?: StoredOAuthTokens;
  private verifier?: string;

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Agentor MCP tests',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() { return this.info; }
  saveClientInformation(info: StoredOAuthClientInformation) { this.info = info; }
  tokens() { return this.storedTokens; }
  saveTokens(tokens: StoredOAuthTokens) { this.storedTokens = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error('no PKCE verifier saved');
    return this.verifier;
  }
}

/**
 * Plays the user's part of an OAuth authorization with the browser session in
 * `session`: follows the authorize URL, answers the consent screen, and
 * returns the URL the authorization server redirects back to the client with.
 */
export async function approveAuthorization(
  session: APIRequestContext,
  authorizationUrl: URL,
  accept = true,
): Promise<URL> {
  const res = await session.get(authorizationUrl.toString(), { maxRedirects: 0 });
  const location = res.headers()['location'];
  if (!location) throw new Error(`authorize did not redirect: ${res.status()} ${await res.text()}`);
  const next = new URL(location, BASE_URL);
  if (next.pathname !== '/oauth/consent') return next;

  // What the consent page does: POST the decision with the signed query.
  const consent = await session.post('/api/auth/oauth2/consent', {
    headers: { Accept: 'application/json' },
    data: { accept, oauth_query: next.search.slice(1) },
  });
  if (!consent.ok()) throw new Error(`consent failed: ${consent.status()} ${await consent.text()}`);
  const body = await consent.json();
  return new URL(body.url);
}

// ─── Hand-driven OAuth steps (for tests that inspect individual steps) ─────────

export const ISSUER = `${BASE_URL}/api/auth`;
export const MCP_SCOPES = 'openid profile email offline_access agentor';

/** Registers a public OAuth client via Dynamic Client Registration (no session). */
export async function registerPublicClient(
  ctx: APIRequestContext,
  name = 'Agentor test client',
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const res = await ctx.post(`${ISSUER}/oauth2/register`, {
    data: {
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...metadata,
    },
  });
  if (!res.ok()) throw new Error(`client registration failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).client_id;
}

/** An authorization request with PKCE for `clientId`, audience-bound to the MCP resource. */
export function authorizationRequest(clientId: string): { url: URL; verifier: string; state: string } {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  const url = new URL(`${ISSUER}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: MCP_SCOPES,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: MCP_URL,
  }).toString();
  return { url, verifier, state };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/** Token endpoint call (authorization_code or refresh_token grant). */
export async function requestTokens(ctx: APIRequestContext, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await ctx.post(`${ISSUER}/oauth2/token`, { form: { resource: MCP_URL, ...params } });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** Full hand-driven flow: register, authorize as `session`'s user, exchange the code. */
export async function obtainTokens(session: APIRequestContext): Promise<TokenResponse & { clientId: string }> {
  const clientId = await registerPublicClient(session);
  const { url, verifier } = authorizationRequest(clientId);
  const callback = await approveAuthorization(session, url);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`no authorization code in ${callback}`);
  const { status, body } = await requestTokens(session, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (status !== 200) throw new Error(`token exchange failed: ${status} ${JSON.stringify(body)}`);
  return { ...body, clientId };
}

export interface McpConnection {
  client: Client;
  provider: TestOAuthProvider;
  accessToken: string;
  close(): Promise<void>;
}

function newClient(): Client {
  return new Client({ name: 'agentor-tests', version: '1.0.0' });
}

/**
 * Connects an MCP client as the user signed in to `session`, running the full
 * OAuth flow: the first connect is challenged (401 + RFC 9728 metadata), the
 * SDK discovers the authorization server and registers a client, the user
 * approves on the consent screen, and the SDK exchanges the code for tokens.
 */
export async function connectMcp(session: APIRequestContext): Promise<McpConnection> {
  const provider = new TestOAuthProvider();
  const challenged = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  try {
    await newClient().connect(challenged);
    throw new Error('expected the unauthenticated MCP connect to be challenged');
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }
  if (!provider.authorizationUrl) throw new Error('the MCP SDK did not start an authorization');

  const callback = await approveAuthorization(session, provider.authorizationUrl);
  await challenged.finishAuth(callback.searchParams);

  const client = newClient();
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider }));
  return {
    client,
    provider,
    accessToken: provider.tokens()!.access_token,
    close: () => client.close(),
  };
}

/** Connects a client with a fixed bearer token (no OAuth flow). */
export async function connectMcpWithToken(accessToken: string): Promise<Client> {
  const client = newClient();
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    authProvider: { token: async () => accessToken },
  }));
  return client;
}

/** Concatenated text content of a tool result. */
export function resultText(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Calls a tool and parses its JSON text result; throws on a tool error. */
export async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args }) as CallToolResult;
  const text = resultText(result);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

/** Calls a tool expecting an error result; returns the error text. */
export async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args }) as CallToolResult;
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded: ${resultText(result)}`);
  return resultText(result);
}
