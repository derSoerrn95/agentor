import { test, expect, request as playwrightRequest } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createTestUser, deleteTestUser, signedInContext } from '../helpers/test-users';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
import { TEST_ADMIN_EMAIL } from '../global-setup';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.example`;
}

async function canSignIn(email: string, password: string): Promise<boolean> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  try {
    return (await ctx.post('/api/auth/sign-in/email', { data: { email, password } })).ok();
  } finally {
    await ctx.dispose();
  }
}

test.describe('Users API (admin)', () => {
  test('lists users with their role', async ({ request }) => {
    const { status, body } = await new ApiClient(request).listUsers();
    expect(status).toBe(200);
    const admin = body.find((u: { email: string }) => u.email === TEST_ADMIN_EMAIL);
    expect(admin).toMatchObject({ role: 'admin', banned: false });
    for (const key of ['id', 'name', 'email', 'role', 'emailVerified', 'createdAt', 'updatedAt']) {
      expect(admin).toHaveProperty(key);
    }
  });

  test('creates a user who can sign in', async ({ request }) => {
    const api = new ApiClient(request);
    const email = uniqueEmail('created');
    const { status, body } = await api.createUser({ name: 'Created User', email, password: 'created-pass-123' });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: 'Created User', email, role: 'user' });
    try {
      expect(await canSignIn(email, 'created-pass-123')).toBe(true);
    } finally {
      await api.deleteUser(body.id);
    }
  });

  test('creates an admin and lowercases the email', async ({ request }) => {
    const api = new ApiClient(request);
    const email = uniqueEmail('Admin-Case');
    const { status, body } = await api.createUser({ name: 'Second Admin', email, role: 'admin' });
    expect(status).toBe(201);
    expect(body.role).toBe('admin');
    expect(body.email).toBe(email.toLowerCase());
    await api.deleteUser(body.id);
  });

  test('rejects invalid create requests', async ({ request }) => {
    const api = new ApiClient(request);
    for (const data of [
      { email: uniqueEmail('x') },
      { name: 'No Email' },
      { name: 'Bad Email', email: 'not-an-email' },
      { name: 'Short Pw', email: uniqueEmail('x'), password: 'short' },
      { name: 'Bad Role', email: uniqueEmail('x'), role: 'root' },
    ]) {
      const { status } = await api.createUser(data);
      expect(status, JSON.stringify(data)).toBe(400);
    }
    expect((await api.createUser({ name: 'Dup', email: TEST_ADMIN_EMAIL })).status).toBe(409);
  });

  test('updates name, email and role', async ({ request }) => {
    const api = new ApiClient(request);
    const user = await createTestUser('Update Me');
    try {
      const email = uniqueEmail('renamed');
      const { status, body } = await api.updateUser(user.id, { name: 'Renamed', email, role: 'admin' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: user.id, name: 'Renamed', email, role: 'admin' });
      expect(await canSignIn(email, user.password)).toBe(true);

      expect((await api.updateUser(user.id, { email: TEST_ADMIN_EMAIL })).status).toBe(409);
      expect((await api.updateUser(user.id, { role: 'root' })).status).toBe(400);
      expect((await api.updateUser(user.id, { name: '  ' })).status).toBe(400);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test('an admin cannot demote, delete or reset the password of themselves', async ({ request }) => {
    const api = new ApiClient(request);
    const { body: me } = await api.getCurrentUser();
    expect((await api.updateUser(me.id, { role: 'user' })).status).toBe(400);
    expect((await api.deleteUser(me.id)).status).toBe(400);
    expect((await api.setUserPassword(me.id, 'self-reset-password-1')).status).toBe(400);
  });

  test('sets a user password', async ({ request }) => {
    const api = new ApiClient(request);
    const user = await createTestUser('Password Reset');
    try {
      expect((await api.setUserPassword(user.id, 'brand-new-password-1')).status).toBe(200);
      expect(await canSignIn(user.email, 'brand-new-password-1')).toBe(true);
      expect(await canSignIn(user.email, user.password)).toBe(false);
      expect((await api.setUserPassword(user.id, 'short')).status).toBe(400);
      expect((await api.setUserPassword(user.id, undefined)).status).toBe(400);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test('deletes a user', async ({ request }) => {
    const api = new ApiClient(request);
    const user = await createTestUser('Delete Me');
    expect((await api.deleteUser(user.id)).status).toBe(200);
    const { body } = await api.listUsers();
    expect(body.some((u: { id: string }) => u.id === user.id)).toBe(false);
    expect(await canSignIn(user.email, user.password)).toBe(false);
  });

  test('unknown users return 404', async ({ request }) => {
    const api = new ApiClient(request);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await api.updateUser(unknown, { name: 'x' })).status).toBe(404);
    expect((await api.setUserPassword(unknown, 'long-enough-pass')).status).toBe(404);
    expect((await api.deleteUser(unknown)).status).toBe(404);
  });

  test('regular users are forbidden', async () => {
    const user = await createTestUser('Not Admin');
    const ctx = await signedInContext(user.email, user.password);
    try {
      const api = new ApiClient(ctx);
      expect((await api.listUsers()).status).toBe(403);
      expect((await api.createUser({ name: 'x', email: uniqueEmail('x') })).status).toBe(403);
      expect((await api.updateUser(user.id, { role: 'admin' })).status).toBe(403);
      expect((await api.setUserPassword(user.id, 'long-enough-pass')).status).toBe(403);
      expect((await api.deleteUser(user.id)).status).toBe(403);
    } finally {
      await ctx.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('requires authentication', async () => {
    const ctx = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await new ApiClient(ctx).listUsers()).status).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
