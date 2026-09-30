import { posix } from 'node:path';

export const WINDOW_NAME_RE = /^[a-zA-Z0-9_-]+$/;
/** Maximum length of a worker's user-facing display name. The internal worker
 * identity is a UUID, so the display name is a free-form label with only a
 * sanity bound on length. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** The persistent workspace mount inside every worker. */
export const WORKSPACE_ROOT = '/workspace';

/** Resolve a caller-supplied path (relative to, or absolute inside,
 * `/workspace`) to a normalized absolute path. Returns null when it escapes
 * the workspace (e.g. via `..`). */
export function resolveWorkspacePath(path: string): string | null {
  const trimmed = path.trim();
  const absolute = posix.normalize(trimmed.startsWith('/') ? trimmed : posix.join(WORKSPACE_ROOT, trimmed));
  const resolved = absolute.length > 1 ? absolute.replace(/\/+$/, '') : absolute;
  return resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}/`) ? resolved : null;
}
