import { createError } from 'h3';
import { useAuth } from './auth';
import { useOrphanSweeper } from './services';

/**
 * User management on top of better-auth, for the `/api/users` and
 * `/api/account` REST routes. better-auth's admin plugin
 * endpoints only accept a browser session, so these call its server API /
 * internal adapter directly with the same rules the admin plugin applies;
 * callers authorize (`requireAdmin`) first.
 */

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = typeof USER_ROLES[number];

export interface AgentorUser {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
  banned: boolean;
  createdAt: string;
  updatedAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toAgentorUser(user: Record<string, any>): AgentorUser {
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email,
    role: user.role ?? 'user',
    emailVerified: !!user.emailVerified,
    banned: !!user.banned,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt).toISOString(),
  };
}

function httpError(statusCode: number, message: string): never {
  throw createError({ statusCode, statusMessage: message });
}

async function authContext() {
  return useAuth().$context;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

async function assertValidPassword(password: string): Promise<void> {
  const { password: passwordConfig } = await authContext();
  const { minPasswordLength, maxPasswordLength } = passwordConfig.config;
  if (password.length < minPasswordLength) httpError(400, `Password must be at least ${minPasswordLength} characters`);
  if (password.length > maxPasswordLength) httpError(400, `Password must be at most ${maxPasswordLength} characters`);
}

async function normalizeUniqueEmail(email: string, userId?: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) httpError(400, 'Invalid email address');
  const existing = await (await authContext()).internalAdapter.findUserByEmail(normalized);
  if (existing && existing.user.id !== userId) httpError(409, 'A user with this email already exists');
  return normalized;
}

export async function listUsers(): Promise<AgentorUser[]> {
  const users = await (await authContext()).internalAdapter.listUsers(undefined, undefined, { field: 'createdAt', direction: 'asc' });
  return users.map(toAgentorUser);
}

export async function getUser(userId: string): Promise<AgentorUser> {
  const user = await (await authContext()).internalAdapter.findUserById(userId);
  if (!user) httpError(404, 'User not found');
  return toAgentorUser(user);
}

export async function createUser(input: { name: string; email: string; password?: string; role: UserRole }): Promise<AgentorUser> {
  const email = await normalizeUniqueEmail(input.email);
  if (input.password !== undefined) await assertValidPassword(input.password);
  // A server-side call without request headers skips the admin plugin's session
  // check (the route already required an admin) but keeps its creation logic.
  const result = await useAuth().api.createUser({
    body: { name: input.name, email, password: input.password, role: input.role },
  });
  return toAgentorUser(result.user);
}

export async function updateUser(userId: string, patch: { name?: string; email?: string; role?: UserRole }): Promise<AgentorUser> {
  const { internalAdapter } = await authContext();
  if (!(await internalAdapter.findUserById(userId))) httpError(404, 'User not found');
  const data: Record<string, string> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.email !== undefined) data.email = await normalizeUniqueEmail(patch.email, userId);
  if (patch.role !== undefined) data.role = patch.role;
  return toAgentorUser(await internalAdapter.updateUser(userId, data));
}

export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  await assertValidPassword(newPassword);
  const ctx = await authContext();
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user) httpError(404, 'User not found');
  const hash = await ctx.password.hash(newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.createAccount({ userId, providerId: 'credential', accountId: userId, password: hash });
  }
}

/** Deletes a user and their sessions, then sweeps their Agentor data (workers,
 * mappings, custom resources, credentials) right away instead of waiting for
 * the periodic orphan sweep. */
export async function deleteUser(userId: string, actingUserId: string): Promise<void> {
  if (userId === actingUserId) httpError(400, 'You cannot delete yourself');
  const { internalAdapter } = await authContext();
  if (!(await internalAdapter.findUserById(userId))) httpError(404, 'User not found');
  await internalAdapter.deleteUserSessions(userId);
  await internalAdapter.deleteUser(userId);
  useOrphanSweeper().sweep().catch((err) => {
    useLogger().error(`[users] sweep after deleting ${userId} failed: ${err instanceof Error ? err.message : err}`);
  });
}
