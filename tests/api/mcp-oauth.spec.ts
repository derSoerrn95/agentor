import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ApiClient } from '../helpers/api-client';
import { createTestUser, deleteTestUser, signedInContext } from '../helpers/test-users';
import {
  BASE_URL, ISSUER, MCP_URL, REDIRECT_URI,
  approveAuthorization, authorizationRequest, connectMcp, connectMcpWithToken,
  obtainTokens, registerPublicClient, requestTokens } from '../helpers/mcp';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-test', version: '1.0.0' } },
};
const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };

async function anonymousContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
}

test.describe('MCP OAuth authorization', () => {
  test('unauthenticated MCP requests get an RFC 9728 challenge', async () => {
    const ctx = await anonymousContext();
    try {
      const res = await ctx.post('/mcp', { headers: MCP_HEADERS, data: INITIALIZE });
      expect(res.status()).toBe(401);
      const challenge = res.headers()['www-authenticate'];
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
    } finally {
      await ctx.dispose();
    }
  });

  test('serves protected resource metadata for the MCP endpoint', async () => {
    const ctx = await anonymousContext();
    try {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const res = await ctx.get(path);
        expect(res.status(), path).toBe(200);
        const body = await res.json();
        expect(body.resource).toBe(MCP_URL);
        expect(body.authorization_servers).toEqual([ISSUER]);
        expect(body.scopes_supported).toContain('agentor');
        expect(body.bearer_methods_supported).toContain('header');
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('serves authorization server metadata at the issuer-inserted well-known URL', async () => {
    const ctx = await anonymousContext();
    try {
      const res = await ctx.get('/.well-known/oauth-authorization-server/api/auth');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.issuer).toBe(ISSUER);
      expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
      expect(body.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
      expect(body.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
      expect(body.code_challenge_methods_supported).toEqual(['S256']);
      expect(body.scopes_supported).toEqual(expect.arrayContaining(['agentor', 'offline_access']));
      expect(body.client_id_metadata_document_supported).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test('public clients can register dynamically without a session', async () => {
    const ctx = await anonymousContext();
    try {
      const clientId = await registerPublicClient(ctx, 'Anonymous registration');
      expect(clientId).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  test('an unauthenticated authorization redirects to the login page with a signed query', async () => {
    const ctx = await anonymousContext();
    try {
      const { url } = authorizationRequest(await registerPublicClient(ctx));
      const res = await ctx.get(url.toString(), { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      const location = new URL(res.headers()['location'], BASE_URL);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('sig')).toBeTruthy();
      expect(location.searchParams.get('client_id')).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  test('an MCP SDK client completes discovery, registration, consent and token exchange', async ({ request }) => {
    const mcp = await connectMcp(request);
    try {
      expect(mcp.client.getServerVersion()?.name).toBe('agentor');
      const { tools } = await mcp.client.listTools();
      expect(tools.length).toBeGreaterThan(50);
      // offline_access was granted, so the client can refresh without the user.
      expect(mcp.provider.tokens()?.refresh_token).toBeTruthy();
    } finally {
      await mcp.close();
    }
  });

  test('access tokens are JWTs bound to the MCP resource and scoped to agentor', async ({ request }) => {
    const tokens = await obtainTokens(request);
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString());
    expect(payload.aud).toEqual(expect.arrayContaining([MCP_URL]));
    expect(payload.iss).toBe(ISSUER);
    expect(String(payload.scope).split(' ')).toContain('agentor');
    expect(payload.sub).toBeTruthy();
  });

  test('2025-era clients (MCP SDK v1) are served by the same endpoint', async ({ request }) => {
    const { access_token } = await obtainTokens(request);
    const client = new LegacyClient({ name: 'legacy-client', version: '1.0.0' });
    await client.connect(new LegacyTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    }));
    try {
      expect(client.getServerVersion()?.name).toBe('agentor');
      expect(client.getInstructions()).toContain('Agentor');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_current_user');
      const result = await client.callTool({ name: 'get_current_user', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as { text: string }[])[0]!.text).role).toBe('admin');
    } finally {
      await client.close();
    }
  });

  test('a refresh token yields a working new access token', async ({ request }) => {
    const tokens = await obtainTokens(request);
    const { status, body } = await requestTokens(request, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: tokens.clientId,
    });
    expect(status).toBe(200);
    expect(body.access_token).toBeTruthy();
    const client = await connectMcpWithToken(body.access_token);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test('denying consent sends the user back to the client with access_denied', async ({ request }) => {
    const clientId = await registerPublicClient(request, 'Denied client');
    const { url, state } = authorizationRequest(clientId);
    const callback = await approveAuthorization(request, url, false);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(state);
  });

  test('invalid or missing bearer tokens are rejected', async () => {
    const ctx = await anonymousContext();
    try {
      const res = await ctx.post('/mcp', {
        headers: { ...MCP_HEADERS, Authorization: 'Bearer not-a-real-token' },
        data: INITIALIZE,
      });
      expect(res.status()).toBe(401);
      await expect(connectMcpWithToken('also-not-a-token')).rejects.toThrow();
    } finally {
      await ctx.dispose();
    }
  });

  test('the stateless MCP endpoint answers GET with 405', async ({ request }) => {
    const { access_token } = await obtainTokens(request);
    const ctx = await anonymousContext();
    try {
      const res = await ctx.get('/mcp', { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${access_token}` } });
      expect(res.status()).toBe(405);
    } finally {
      await ctx.dispose();
    }
  });

  test('authorized apps start empty; unknown revokes are 404; both need a session', async () => {
    const user = await createTestUser('No Apps');
    const ctx = await signedInContext(user.email, user.password);
    const anonymous = await anonymousContext();
    try {
      const api = new ApiClient(ctx);
      expect(await api.listAuthorizedApps()).toEqual({ status: 200, body: [] });
      expect((await api.revokeAuthorizedApp('https://unknown.example/client.json')).status).toBe(404);
      expect((await new ApiClient(anonymous).listAuthorizedApps()).status).toBe(401);
    } finally {
      await ctx.dispose();
      await anonymous.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('revoking the application cuts off MCP access immediately', async () => {
    const user = await createTestUser('MCP Revoke');
    const session = await signedInContext(user.email, user.password);
    try {
      const tokens = await obtainTokens(session);
      const client = await connectMcpWithToken(tokens.access_token);
      await client.close();

      const api = new ApiClient(session);
      const { body: apps } = await api.listAuthorizedApps();
      expect(apps).toEqual([expect.objectContaining({ clientId: tokens.clientId, scopes: expect.arrayContaining(['agentor']) })]);

      expect((await api.revokeAuthorizedApp(tokens.clientId)).status).toBe(200);
      expect((await api.listAuthorizedApps()).body).toEqual([]);
      // The still-unexpired JWT no longer works, and the refresh token is gone.
      await expect(connectMcpWithToken(tokens.access_token)).rejects.toThrow();
      const refresh = await requestTokens(session, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        client_id: tokens.clientId,
      });
      expect(refresh.status).not.toBe(200);
    } finally {
      await session.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('deleting the user cuts off their MCP access', async () => {
    const user = await createTestUser('MCP Deleted');
    const session = await signedInContext(user.email, user.password);
    const tokens = await obtainTokens(session);
    await session.dispose();
    await deleteTestUser(user.id);
    await expect(connectMcpWithToken(tokens.access_token)).rejects.toThrow();
  });
});
