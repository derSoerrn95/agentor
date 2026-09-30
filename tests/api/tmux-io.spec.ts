import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

/** Polls a tmux window until its captured content matches. */
async function waitForCapture(api: ApiClient, workerId: string, windowIndex: number, pattern: RegExp, history?: number): Promise<string> {
  let content = '';
  await expect.poll(async () => {
    const { body } = await api.captureTmuxWindow(workerId, windowIndex, history);
    content = body.content ?? '';
    return pattern.test(content);
  }, { timeout: 20_000 }).toBe(true);
  return content;
}

test.describe.serial('Tmux send-keys / capture API', () => {
  let workerId: string;
  let windowIndex: number;

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request)).id;
    const { status, body } = await new ApiClient(request).createPane(workerId, `io-${Date.now()}`);
    expect(status).toBe(201);
    windowIndex = body.index;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, workerId);
  });

  test('typed text + Enter runs in the window and the capture shows its output', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.sendTmuxKeys(workerId, windowIndex, { text: 'echo "SUM=$((20+22))"', enter: true });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // `SUM=$((` is what the shell echoes back; `SUM=42` only appears once it ran.
    await waitForCapture(api, workerId, windowIndex, /SUM=42/);
  });

  test('named keys are sent before the text (C-c interrupts a running command)', async ({ request }) => {
    const api = new ApiClient(request);
    await api.sendTmuxKeys(workerId, windowIndex, { text: 'sleep 1000', enter: true });
    const { status } = await api.sendTmuxKeys(workerId, windowIndex, { keys: ['C-c'], text: 'echo "AFTER=$((1+1))"', enter: true });
    expect(status).toBe(200);
    await waitForCapture(api, workerId, windowIndex, /AFTER=2/);
  });

  test('text starting with a dash is typed, not parsed as tmux options', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.sendTmuxKeys(workerId, windowIndex, { text: '- item --help' })).status).toBe(200);
    await waitForCapture(api, workerId, windowIndex, /- item --help$/m);
    // Clear the unsubmitted line again.
    expect((await api.sendTmuxKeys(workerId, windowIndex, { keys: ['C-u'] })).status).toBe(200);
  });

  test('history includes scrollback beyond the visible screen', async ({ request }) => {
    const api = new ApiClient(request);
    await api.sendTmuxKeys(workerId, windowIndex, { text: 'seq 1001 1300', enter: true });
    const visible = await waitForCapture(api, workerId, windowIndex, /^1300$/m);
    expect(visible).not.toMatch(/^1001$/m);
    const withHistory = await waitForCapture(api, workerId, windowIndex, /^1001$/m, 2000);
    expect(withHistory).toMatch(/^1300$/m);
  });

  test('unknown window returns 404', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.captureTmuxWindow(workerId, 99)).status).toBe(404);
    expect((await api.sendTmuxKeys(workerId, 99, { text: 'x' })).status).toBe(404);
  });

  test('validates input', async ({ request }) => {
    const api = new ApiClient(request);
    for (const data of [
      {},
      { keys: 'C-c' },
      { keys: ['rm -rf /'] },
      { keys: ['-t'] },
      { text: 42 },
      { enter: 'yes' },
    ]) {
      const { status } = await api.sendTmuxKeys(workerId, windowIndex, data);
      expect(status, JSON.stringify(data)).toBe(400);
    }
    expect((await api.sendTmuxKeys(workerId, 'abc', { text: 'x' })).status).toBe(400);
    expect((await api.captureTmuxWindow(workerId, windowIndex, -1)).status).toBe(400);
    expect((await api.captureTmuxWindow(workerId, windowIndex, 'lots')).status).toBe(400);
  });

  test('returns 404 for an unknown worker', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.captureTmuxWindow('00000000-0000-4000-8000-000000000000', 0)).status).toBe(404);
  });
});
