import { useAuth } from './auth';

/**
 * OAuth applications (MCP clients) a user has authorized.
 *
 * An authorization is represented by better-auth's `oauthConsent` row, written
 * when the user approves the client on the consent screen. Revoking deletes
 * that consent together with the client's refresh and opaque access tokens,
 * and the MCP endpoint requires a live consent on every request — so a
 * revoked client loses access immediately, not only once its (stateless JWT)
 * access token expires.
 */

export interface AuthorizedApp {
  clientId: string;
  name: string;
  uri?: string;
  scopes: string[];
  authorizedAt: string;
}

interface ConsentRow {
  clientId: string;
  userId: string;
  scopes: string[] | string;
  createdAt: Date | string;
}

interface ClientRow {
  clientId: string;
  name?: string | null;
  uri?: string | null;
}

async function adapter() {
  return (await useAuth().$context).adapter;
}

function byUserAndClient(userId: string, clientId: string) {
  return [
    { field: 'userId', value: userId },
    { field: 'clientId', value: clientId },
  ];
}

export async function listAuthorizedApps(userId: string): Promise<AuthorizedApp[]> {
  const db = await adapter();
  const consents: ConsentRow[] = await db.findMany({ model: 'oauthConsent', where: [{ field: 'userId', value: userId }] });
  return Promise.all(consents.map(async (consent) => {
    const client: ClientRow | null = await db.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: consent.clientId }] });
    const scopes = Array.isArray(consent.scopes) ? consent.scopes : String(consent.scopes ?? '').split(' ').filter(Boolean);
    return {
      clientId: consent.clientId,
      name: client?.name || consent.clientId,
      ...(client?.uri ? { uri: client.uri } : {}),
      scopes,
      authorizedAt: new Date(consent.createdAt).toISOString(),
    };
  }));
}

export async function hasAuthorizedApp(userId: string, clientId: string): Promise<boolean> {
  const consent: ConsentRow | null = await (await adapter()).findOne({ model: 'oauthConsent', where: byUserAndClient(userId, clientId) });
  return !!consent;
}

/** Revokes the user's authorization of `clientId`. Returns false when there was none. */
export async function revokeAuthorizedApp(userId: string, clientId: string): Promise<boolean> {
  if (!(await hasAuthorizedApp(userId, clientId))) return false;
  const db = await adapter();
  const where = byUserAndClient(userId, clientId);
  await db.deleteMany({ model: 'oauthRefreshToken', where });
  await db.deleteMany({ model: 'oauthAccessToken', where });
  await db.deleteMany({ model: 'oauthConsent', where });
  return true;
}
