import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Registry credentials for the orchestrator's own pulls and update checks.
 * Two sources, the first match wins:
 *
 * 1. `REGISTRY_CREDENTIALS` — comma-separated `host=username:password`:
 *
 *        REGISTRY_CREDENTIALS=registry.example.com=deploy:glpat-xxx,ghcr.io=me:ghp_xxx
 *
 *    The password may contain `:` (only the first one separates it from the
 *    username) but not `,`. Use `docker.io` for Docker Hub.
 *
 * 2. A Docker client config — the `config.json` that `docker login` writes,
 *    e.g. the host's, mounted read-only:
 *
 *        - /root/.docker/config.json:/root/.docker/config.json:ro
 *
 *    Location: `$DOCKER_CONFIG/config.json`, else `~/.docker/config.json`.
 *    Only inline `auths` entries are supported (`auth` = base64
 *    `user:password`, or `username` + `password`); credential helpers
 *    (`credsStore`/`credHelpers`) need their binaries and are ignored. The file
 *    is re-read on every lookup, so a re-login is picked up without a restart.
 *
 * With neither, nothing changes: every pull and check stays anonymous.
 */

export interface RegistryCredential {
  username: string;
  password: string;
  serveraddress: string;
}

const DOCKER_HUB_KEYS = ['https://index.docker.io/v1/', 'index.docker.io', 'docker.io', 'registry-1.docker.io'];

function configPath(): string {
  const dir = process.env.DOCKER_CONFIG || join(homedir(), '.docker');
  return join(dir, 'config.json');
}

/** Normalize an `auths` key or registry host to a bare host[:port]. */
function normalizeHost(key: string): string {
  const host = key.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  return DOCKER_HUB_KEYS.includes(host) ? 'docker.io' : host.toLowerCase();
}

/** Registry host of an image reference, per Docker's reference grammar: the
 * first path segment is a registry when it contains `.` or `:` or is
 * `localhost`; everything else lives on Docker Hub. */
export function registryHostOf(image: string): string {
  const first = image.split('/')[0] ?? '';
  const isHost = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return isHost ? normalizeHost(first) : 'docker.io';
}

function credentialFromEnv(wanted: string): RegistryCredential | undefined {
  for (const entry of (process.env.REGISTRY_CREDENTIALS || '').split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    if (normalizeHost(entry.slice(0, eq).trim()) !== wanted) continue;
    const userPass = entry.slice(eq + 1).trim();
    const sep = userPass.indexOf(':');
    if (sep <= 0 || sep === userPass.length - 1) continue; // malformed: try the next source
    return {
      username: userPass.slice(0, sep),
      password: userPass.slice(sep + 1),
      serveraddress: wanted === 'docker.io' ? 'https://index.docker.io/v1/' : wanted,
    };
  }
  return undefined;
}

export function registryCredential(registry: string): RegistryCredential | undefined {
  const fromEnv = credentialFromEnv(normalizeHost(registry));
  if (fromEnv) return fromEnv;
  let auths: Record<string, { auth?: string; username?: string; password?: string }>;
  try {
    auths = (JSON.parse(readFileSync(configPath(), 'utf-8')) as { auths?: typeof auths }).auths ?? {};
  } catch {
    return undefined; // no file / unreadable / not JSON: anonymous, as before
  }
  const wanted = normalizeHost(registry);
  for (const [key, entry] of Object.entries(auths)) {
    if (normalizeHost(key) !== wanted) continue;
    let username = entry.username ?? '';
    let password = entry.password ?? '';
    if (entry.auth) {
      const decoded = Buffer.from(entry.auth, 'base64').toString('utf-8');
      const sep = decoded.indexOf(':');
      if (sep > 0) {
        username = decoded.slice(0, sep);
        password = decoded.slice(sep + 1);
      }
    }
    if (!username || !password) return undefined;
    return {
      username,
      password,
      serveraddress: wanted === 'docker.io' ? 'https://index.docker.io/v1/' : wanted,
    };
  }
  return undefined;
}

/** dockerode pull options carrying the credential for `image`, if any. */
export function pullOptionsFor(image: string): { authconfig?: RegistryCredential } {
  const cred = registryCredential(registryHostOf(image));
  return cred ? { authconfig: cred } : {};
}

export function basicAuthHeader(cred: RegistryCredential): string {
  return `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`;
}
