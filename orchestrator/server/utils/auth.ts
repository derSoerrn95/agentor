import { betterAuth } from 'better-auth';
import { admin, jwt } from 'better-auth/plugins';
import { createAuthMiddleware } from 'better-auth/api';
import { passkey } from '@better-auth/passkey';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from './config';
import { consumeSetupToken } from './setup-token-store';

// The return type of `betterAuth()` varies with plugins; we cast to any
// downstream to avoid double-type-definition issues from nested Zod/better-call.
let _auth: any = null;
let _db: Database.Database | null = null;

/**
 * Resolves the BETTER_AUTH_SECRET.
 * Reads from the parsed config first (`BETTER_AUTH_SECRET`), otherwise
 * generates one and persists it to `<dataDir>/auth.secret` on first run so the
 * secret survives restarts.
 */
function resolveAuthSecret(config: ReturnType<typeof loadConfig>): string {
  const envSecret = config.betterAuthSecret?.trim();
  if (envSecret) return envSecret;

  const dataDir = config.dataDir;

  const secretPath = join(dataDir, 'auth.secret');
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf-8').trim();
  }

  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretPath, generated, { encoding: 'utf-8' });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Ignore chmod failures on platforms that don't support it
  }
  return generated;
}

/**
 * Builds the list of trusted origins that better-auth will accept on the
 * `Origin` header of mutating requests (CSRF protection). Includes:
 *
 *   1. Direct dev access: `http://localhost:3000`, `http://127.0.0.1:3000`
 *   2. The dashboard URL when Traefik domain routing is configured
 *      (`DASHBOARD_SUBDOMAIN.DASHBOARD_BASE_DOMAIN`, both http and https variants)
 *   3. The public base URL (`BETTER_AUTH_URL`, else the dashboard URL)
 *   4. Any extra origins from `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated)
 */
function buildTrustedOrigins(config: ReturnType<typeof loadConfig>): string[] {
  const origins = new Set<string>([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);

  // BETTER_AUTH_URL, or the auto-derived dashboard URL when unset.
  origins.add(config.publicBaseUrl);

  if (config.dashboardSubdomain && config.dashboardBaseDomain) {
    const host = `${config.dashboardSubdomain}.${config.dashboardBaseDomain}`;
    // Trust both http and https — the scheme depends on the base domain's
    // TLS challenge type, and the browser's Origin header reflects whichever
    // scheme the user actually hit.
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }

  // `config.betterAuthTrustedOrigins` is already trimmed/split/filtered.
  for (const o of config.betterAuthTrustedOrigins) {
    origins.add(o);
  }

  return Array.from(origins);
}

export interface PasskeyConfig {
  enabled: boolean;
  /** The full dashboard host (e.g. `dash.docker.localhost`). Used as rpID. */
  rpID?: string;
  /** The public https URL the dashboard is served from. Used as origin. */
  origin?: string;
}

/**
 * Decides whether passkey authentication should be available, and what rpID
 * and origin to pass to the passkey plugin.
 *
 * WebAuthn requires:
 *   1. An `origin` that's either `https://...` or `http://localhost` (strict!)
 *   2. An `rpID` that's a registrable suffix of the browser's current origin
 *
 * If the dashboard is served over Traefik (DASHBOARD_SUBDOMAIN and
 * DASHBOARD_BASE_DOMAIN are set), we use that domain as both the origin and
 * the rpID. Otherwise passkeys are disabled entirely — they can't be made to
 * work reliably when the dashboard is reached by raw IP / localhost because
 * the rpID would have to match whatever the browser happens to be on.
 *
 * Override the auto-detected rpID via `BETTER_AUTH_RP_ID` for advanced setups.
 */
function resolvePasskeyConfig(config: ReturnType<typeof loadConfig>): PasskeyConfig {
  const sub = config.dashboardSubdomain;
  const base = config.dashboardBaseDomain;
  if (!sub || !base) {
    return { enabled: false };
  }

  const host = `${sub}.${base}`;
  const origin = `https://${host}`;
  const rpID = config.betterAuthRpId || host;
  return { enabled: true, rpID, origin };
}

/** Path of the MCP endpoint (Streamable HTTP), relative to the public base URL. */
export const MCP_PATH = '/mcp';
/** The single OAuth scope that grants an MCP client full access to the
 * authorizing user's Agentor account (the same rights the user has in the
 * dashboard). Finer-grained scopes can be added to `scopes` later. */
export const MCP_SCOPE = 'agentor';
/** Scopes every MCP access token must carry. */
export const MCP_REQUIRED_SCOPES = [MCP_SCOPE] as const;
const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', MCP_SCOPE];

export interface McpAuthConfig {
  enabled: boolean;
  /** Canonical protected-resource URL (`<publicBaseUrl>/mcp`); the `aud` of every MCP access token. */
  resource?: string;
  /** Why MCP is disabled (surfaced in logs and settings). */
  disabledReason?: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Decides whether the MCP server (and its OAuth 2.1 authorization server) is
 * enabled, and under which resource URL. MCP requires the resource URL to be
 * HTTPS — plain HTTP is only accepted on loopback hosts for local development —
 * so an http dashboard domain disables MCP instead of failing auth init.
 */
export function resolveMcpConfig(config: ReturnType<typeof loadConfig>): McpAuthConfig {
  if (!config.mcpEnabled) return { enabled: false, disabledReason: 'MCP_ENABLED=false' };
  const resource = `${config.publicBaseUrl}${MCP_PATH}`;
  const url = new URL(resource);
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    return {
      enabled: false,
      disabledReason: `MCP requires an https public URL (got ${config.publicBaseUrl}); set BETTER_AUTH_URL to the https dashboard URL`,
    };
  }
  return { enabled: true, resource };
}

const LOOPBACK_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * RFC 8252 §7.3: a client whose redirect URIs are all http loopback URIs is a
 * native app. OIDC dynamic registration defaults `application_type` to `web`,
 * which forbids loopback redirects — so the MCP clients that register without
 * an `application_type` (the MCP Inspector, IDE agents, …) would be rejected.
 * Classify them as native instead; explicit values are left untouched.
 */
function defaultLoopbackClientsToNative(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body || body.application_type !== undefined) return undefined;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return undefined;
  const allLoopback = uris.every((uri) => {
    try {
      const url = new URL(String(uri));
      return url.protocol === 'http:' && LOOPBACK_REDIRECT_HOSTS.has(url.hostname);
    } catch {
      return false;
    }
  });
  return allLoopback ? { ...body, application_type: 'native' } : undefined;
}

function buildAuth(): any {
  const config = loadConfig();
  const dbPath = join(config.dataDir, 'auth.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Wait up to 5s for a write lock instead of failing immediately with
  // SQLITE_BUSY. During the update/swap flow (docs/production.md) the `-next`
  // and old orchestrator containers briefly run concurrently against the same
  // auth.db; migrations are idempotent, so a short busy-wait avoids a spurious
  // failure if both run getMigrations().runMigrations() at the same instant.
  db.pragma('busy_timeout = 5000');
  _db = db;

  const baseURL = config.publicBaseUrl;
  const passkeyCfg = resolvePasskeyConfig(config);
  const mcpCfg = resolveMcpConfig(config);

  return betterAuth({
    database: db,
    basePath: '/api/auth',
    baseURL,
    // The jwt plugin's `/token` endpoint mints a JWT from a *session*; with the
    // OAuth provider enabled, access tokens must only come from `/oauth2/token`.
    disabledPaths: ['/token'],
    secret: resolveAuthSecret(config),
    trustedOrigins: buildTrustedOrigins(config),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/oauth2/register') return;
        const body = defaultLoopbackClientsToNative(ctx.body);
        if (body) return { context: { body } };
      }),
    },
    user: {
      // Allow users to change their own email without email verification.
      // Agentor does not send email, so we rely on the in-app session to
      // authorise the change (the user must still be signed in).
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: true,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
    },
    advanced: {
      cookiePrefix: 'agentor',
      // The dashboard is served through Traefik (DASHBOARD_SUBDOMAIN), so the
      // socket source IP is Traefik's container IP for every request. Derive
      // the real client IP from the `X-Forwarded-For` header (which Traefik
      // sets by default) so rate limiting / brute-force protection is keyed
      // per client, not per proxy. This is also better-auth's default header,
      // but we set it explicitly to document the Traefik dependency.
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for'],
      },
      database: {
        // Mint UUID v4 ids for all auth models (user, session, account, …) so
        // userIds are UUIDs — matching every other resource in the system.
        // Existing rows keep their previous ids; only new records get UUIDs.
        generateId: 'uuid',
      },
    },
    plugins: [
      admin(),
      ...(mcpCfg.enabled
        ? [
            // Signs the OAuth access tokens (JWTs bound to the MCP resource)
            // and serves the JWKS the MCP endpoint verifies them against.
            jwt(),
            // OAuth 2.1 authorization server for MCP clients: discovery
            // metadata (RFC 8414 / RFC 9728), authorization code + PKCE,
            // refresh tokens, consent. Users sign in on the regular /login page
            // and approve the client on /oauth/consent.
            mcp({
              resource: mcpCfg.resource!,
              loginPage: '/login',
              consentPage: '/oauth/consent',
              scopes: OAUTH_SCOPES,
              clientRegistrationDefaultScopes: OAUTH_SCOPES,
              // Dynamic Client Registration is still how most MCP clients
              // onboard; CIMD (below) covers the MCP 2026-07-28 profile.
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
            }),
            cimd({
              fetchClientMetadataResource,
              metadataProfile: 'mcp-2026-07-28',
            }),
          ]
        : []),
      ...(passkeyCfg.enabled
        ? [
            passkey({
              rpName: 'Agentor',
              rpID: passkeyCfg.rpID!,
              origin: passkeyCfg.origin!,
              registration: {
                // Allow passkey registration without an existing session —
                // required for the first-run admin setup and for any
                // "passkey-only" account creation flow. The `resolveUser`
                // callback (below) consumes a one-shot token to look up or
                // create the user.
                requireSession: false,
                resolveUser: async ({ context }) => {
                  const meta = consumeSetupToken(context);
                  if (!meta) {
                    throw new Error('Invalid or expired setup token');
                  }
                  // First-admin tokens may only be redeemed when no users exist.
                  if (meta.initialAdmin && hasAnyUsers()) {
                    throw new Error('Setup is already complete');
                  }

                  const db = getAuthDb();
                  // Has the user been pre-created (e.g. admin used the
                  // regular create-user flow without password)? If so, just
                  // bind the new passkey to that user.
                  const existing = db
                    .prepare('SELECT id, name FROM user WHERE email = ?')
                    .get(meta.email) as { id: string; name: string } | undefined;
                  if (existing) {
                    return { id: existing.id, name: existing.name };
                  }

                  // Otherwise create a fresh user (no password). The schema
                  // insert goes through the kysely adapter by way of direct
                  // SQL (faster than the plugin's full insert pipeline, and
                  // the passkey row is written by the plugin right after
                  // this callback returns).
                  //
                  // Use a UUID v4 to match `advanced.database.generateId: 'uuid'`
                  // so a passkey-first admin gets the same id shape as every
                  // password-created user (per-user data dirs, worker userId
                  // FKs, and ownership checks all key off this id).
                  const now = new Date();
                  const id = randomUUID();
                  db.prepare(
                    `INSERT INTO user (id, email, name, emailVerified, role, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  ).run(id, meta.email, meta.name, 0, meta.role, now.toISOString(), now.toISOString());
                  return { id, name: meta.name };
                },
              },
            }),
          ]
        : []),
    ],
  });
}

/** Returns the resolved MCP / OAuth configuration (see `resolveMcpConfig`). */
export function getMcpAuthConfig(): McpAuthConfig {
  return resolveMcpConfig(loadConfig());
}

/** Returns whether passkey authentication is enabled (dashboard is on Traefik). */
export function isPasskeyEnabled(): boolean {
  return resolvePasskeyConfig(loadConfig()).enabled;
}

export function useAuth(): any {
  if (!_auth) _auth = buildAuth();
  return _auth;
}

/**
 * Runs better-auth schema migrations against the SQLite database.
 * Safe to call on every startup — creates missing tables/columns only.
 */
export async function migrateAuth(): Promise<void> {
  const auth = useAuth();
  const migrations = await getMigrations({ ...auth.options, logger: { log: logMigrationMessage } });
  await migrations.runMigrations();
}

/**
 * better-auth's migrator creates `string[]` columns (OAuth scopes, redirect
 * URIs, …) as `TEXT` on SQLite, then its own drift check expects a JSON type
 * and warns on every startup. That self-contradiction is dropped; every other
 * migration message is printed as better-auth would.
 */
const SQLITE_ARRAY_TYPE_DRIFT_RE = /^Field \w+ in table \w+ has a different type in the database\. Expected (string|number)\[\] but got TEXT\.$/i;

function logMigrationMessage(level: string, message: string, ...args: unknown[]): void {
  if (SQLITE_ARRAY_TYPE_DRIFT_RE.test(message)) return;
  const line = `[Better Auth]: ${message}`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export function getAuthDb(): Database.Database {
  if (!_db) useAuth();
  return _db!;
}

/** Returns true if at least one user exists. */
export function hasAnyUsers(): boolean {
  const db = getAuthDb();
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM user').get() as { c: number } | undefined;
    return (row?.c ?? 0) > 0;
  } catch {
    // Table may not exist yet on a very fresh DB — treat as no users
    return false;
  }
}

/** Sets a user's role directly in the database (used by first-run setup). */
export function setUserRoleDirect(userId: string, role: string): void {
  const db = getAuthDb();
  db.prepare('UPDATE user SET role = ? WHERE id = ?').run(role, userId);
}

/** Look up a user's display name + email by id (the worker owner's git identity).
 * Resolved live at container build time rather than snapshotted onto the worker —
 * the worker references the owner by `userId` only. Returns `null` if the user
 * no longer exists. */
export function getUserById(userId: string): { name: string; email: string } | null {
  if (!userId) return null;
  const db = getAuthDb();
  const row = db.prepare('SELECT name, email FROM user WHERE id = ?').get(userId) as
    | { name?: string; email?: string }
    | undefined;
  if (!row) return null;
  return { name: row.name ?? '', email: row.email ?? '' };
}

export interface CredentialSummary {
  hasPassword: boolean;
  passkeyCount: number;
}

/**
 * Counts a user's available credentials. Used to enforce the "at least one
 * credential" invariant when removing a password or deleting the last passkey.
 *
 * - `hasPassword` is true when a row exists in the `account` table with
 *   `providerId = 'credential'` (better-auth's name for the email/password
 *   provider).
 * - `passkeyCount` is the number of rows in the `passkey` table for the user.
 */
export function getCredentialSummary(userId: string): CredentialSummary {
  const db = getAuthDb();
  let hasPassword = false;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL`,
      )
      .get(userId) as { c: number } | undefined;
    hasPassword = (row?.c ?? 0) > 0;
  } catch {
    hasPassword = false;
  }

  let passkeyCount = 0;
  try {
    const row = db
      .prepare('SELECT COUNT(*) as c FROM passkey WHERE userId = ?')
      .get(userId) as { c: number } | undefined;
    passkeyCount = row?.c ?? 0;
  } catch {
    passkeyCount = 0;
  }

  return { hasPassword, passkeyCount };
}

/**
 * Removes a user's password credential. Used by the `remove-password`
 * endpoint after the caller has verified at least one passkey is registered.
 */
export function removeUserPassword(userId: string): void {
  const db = getAuthDb();
  db.prepare(
    `DELETE FROM account WHERE userId = ? AND providerId = 'credential'`,
  ).run(userId);
}
