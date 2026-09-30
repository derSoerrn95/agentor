import { test, expect, request as playwrightRequest } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser, signedInContext } from '../helpers/test-users';

test.describe.serial('Worker exec API', () => {
  let workerId: string;

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request)).id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, workerId);
  });

  test('runs a command and returns its stdout and exit code', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.execCommand(workerId, { command: 'echo "V=$((6*7))"' });
    expect(status).toBe(200);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe('V=42\n');
    expect(body.stderr).toBe('');
    expect(body.truncated).toBe(false);
    expect(body.timedOut).toBe(false);
    expect(typeof body.durationMs).toBe('number');
  });

  test('reports a non-zero exit code and stderr separately', async ({ request }) => {
    const api = new ApiClient(request);
    const { body } = await api.execCommand(workerId, { command: 'echo out; echo err >&2; exit 3' });
    expect(body.exitCode).toBe(3);
    expect(body.stdout).toBe('out\n');
    expect(body.stderr).toBe('err\n');
  });

  test('runs as the agent user in /workspace with the agent CLIs on PATH', async ({ request }) => {
    const api = new ApiClient(request);
    const { body } = await api.execCommand(workerId, { command: 'echo "$(whoami):$(pwd)"; command -v claude' });
    expect(body.exitCode).toBe(0);
    const [identity, claudePath] = body.stdout.trim().split('\n');
    expect(identity).toBe('agent:/workspace');
    expect(claudePath).toContain('claude');
  });

  test('honours cwd', async ({ request }) => {
    const api = new ApiClient(request);
    const { body } = await api.execCommand(workerId, { command: 'pwd', cwd: '/tmp' });
    expect(body.stdout.trim()).toBe('/tmp');
  });

  test('kills the command at the timeout', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.execCommand(workerId, { command: 'sleep 60', timeoutSeconds: 1 });
    expect(status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(body.exitCode).not.toBe(0);
    expect(body.durationMs).toBeLessThan(20_000);
  });

  test('truncates output above the cap', async ({ request }) => {
    const api = new ApiClient(request);
    const { body } = await api.execCommand(workerId, { command: "head -c 2000000 /dev/zero | tr '\\0' a" });
    expect(body.exitCode).toBe(0);
    expect(body.truncated).toBe(true);
    expect(body.stdout.length).toBe(1024 * 1024);
  });

  test('validates the request body', async ({ request }) => {
    const api = new ApiClient(request);
    for (const data of [
      {},
      { command: '' },
      { command: 42 },
      { command: 'true', cwd: 'relative/dir' },
      { command: 'true', timeoutSeconds: 0 },
      { command: 'true', timeoutSeconds: 601 },
      { command: 'true', timeoutSeconds: 'soon' },
    ]) {
      const { status } = await api.execCommand(workerId, data);
      expect(status, JSON.stringify(data)).toBe(400);
    }
  });

  test('returns 404 for an unknown worker', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.execCommand('00000000-0000-4000-8000-000000000000', { command: 'true' });
    expect(status).toBe(404);
  });

  test('refuses another user\'s worker with 403', async () => {
    const user = await createTestUser('Exec Outsider');
    const ctx = await signedInContext(user.email, user.password);
    try {
      const { status } = await new ApiClient(ctx).execCommand(workerId, { command: 'true' });
      expect(status).toBe(403);
    } finally {
      await ctx.dispose();
      await deleteTestUser(user.id);
    }
  });

  test('requires authentication', async () => {
    const ctx = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const { status } = await new ApiClient(ctx).execCommand(workerId, { command: 'true' });
      expect(status).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('returns 409 when the worker is stopped', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.stopContainer(workerId)).status).toBe(200);
    const { status } = await api.execCommand(workerId, { command: 'true' });
    expect(status).toBe(409);
  });
});
