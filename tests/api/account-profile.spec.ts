import { test, expect, request as playwrightRequest } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createTestUser, deleteTestUser, signedInContext } from '../helpers/test-users';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_NAME } from '../global-setup';

test.describe('Account: current user + profile', () => {
  test('GET /api/account/me returns the signed-in user', async ({ request }) => {
    const { status, body } = await new ApiClient(request).getCurrentUser();
    expect(status).toBe(200);
    expect(body).toMatchObject({ email: TEST_ADMIN_EMAIL, name: TEST_ADMIN_NAME, role: 'admin' });
    expect(body.id).toBeTruthy();
  });

  test('a user updates their own name and email', async () => {
    const user = await createTestUser('Profile Owner');
    const ctx = await signedInContext(user.email, user.password);
    try {
      const api = new ApiClient(ctx);
      const email = `profile-${Date.now()}@test.example`;
      const { status, body } = await api.updateAccountProfile({ name: 'New Name', email });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: user.id, name: 'New Name', email, role: 'user' });
      expect((await api.getCurrentUser()).body).toMatchObject({ name: 'New Name', email });
    } finally {
      await ctx.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('profile updates are validated', async () => {
    const user = await createTestUser('Profile Validation');
    const ctx = await signedInContext(user.email, user.password);
    try {
      const api = new ApiClient(ctx);
      expect((await api.updateAccountProfile({})).status).toBe(400);
      expect((await api.updateAccountProfile({ name: '' })).status).toBe(400);
      expect((await api.updateAccountProfile({ email: 'nope' })).status).toBe(400);
      expect((await api.updateAccountProfile({ email: TEST_ADMIN_EMAIL })).status).toBe(409);
      // A user cannot escalate through the profile endpoint.
      const { body } = await api.updateAccountProfile({ name: 'Still User', role: 'admin' });
      expect(body.role).toBe('user');
    } finally {
      await ctx.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('requires authentication', async () => {
    const ctx = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const api = new ApiClient(ctx);
      expect((await api.getCurrentUser()).status).toBe(401);
      expect((await api.updateAccountProfile({ name: 'x' })).status).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
