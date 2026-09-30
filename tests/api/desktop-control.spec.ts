import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads width/height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function pointer(api: ApiClient, workerId: string): Promise<string> {
  const { body } = await api.execCommand(workerId, { command: 'DISPLAY=:99 xdotool getmouselocation --shell | head -2 | tr "\\n" " "' });
  return body.stdout.trim();
}

test.describe.serial('Desktop screenshot / input API', () => {
  let workerId: string;

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request)).id;
    // The display stack comes up a few seconds after the container starts.
    const api = new ApiClient(request);
    await expect.poll(async () => (await api.getDesktopScreenshot(workerId)).status, { timeout: 60_000 }).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, workerId);
  });

  test('screenshot returns a 1920x1080 PNG of the virtual display', async ({ request }) => {
    const { status, headers, body } = await new ApiClient(request).getDesktopScreenshot(workerId);
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('image/png');
    expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngSize(body)).toEqual({ width: 1920, height: 1080 });
  });

  test('move places the pointer at the given coordinates', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.sendDesktopInput(workerId, { action: 'move', x: 120, y: 240 })).status).toBe(200);
    expect(await pointer(api, workerId)).toBe('X=120 Y=240');
  });

  test('click at a position moves the pointer there and clicks', async ({ request }) => {
    const api = new ApiClient(request);
    for (const action of ['click', 'double_click', 'right_click', 'middle_click']) {
      const { status, body } = await api.sendDesktopInput(workerId, { action, x: 300, y: 400 });
      expect(status, action).toBe(200);
      expect(body).toEqual({ ok: true });
    }
    expect(await pointer(api, workerId)).toBe('X=300 Y=400');
  });

  test('drag ends at the target coordinates', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.sendDesktopInput(workerId, { action: 'drag', x: 10, y: 10, toX: 500, toY: 600 })).status).toBe(200);
    expect(await pointer(api, workerId)).toBe('X=500 Y=600');
  });

  test('scroll, type and key actions succeed', async ({ request }) => {
    const api = new ApiClient(request);
    expect((await api.sendDesktopInput(workerId, { action: 'scroll', direction: 'down', amount: 2 })).status).toBe(200);
    expect((await api.sendDesktopInput(workerId, { action: 'scroll', x: 50, y: 50, direction: 'up' })).status).toBe(200);
    expect((await api.sendDesktopInput(workerId, { action: 'type', text: 'hello agentor' })).status).toBe(200);
    expect((await api.sendDesktopInput(workerId, { action: 'key', keys: 'ctrl+a BackSpace Return' })).status).toBe(200);
  });

  test('validates actions', async ({ request }) => {
    const api = new ApiClient(request);
    for (const data of [
      {},
      { action: 'teleport' },
      { action: 'move' },
      { action: 'click', x: 10 },
      { action: 'click', x: -1, y: 5 },
      { action: 'drag', x: 1, y: 1 },
      { action: 'type' },
      { action: 'key', keys: 'ctrl+c; rm -rf /' },
      { action: 'scroll', direction: 'sideways' },
      { action: 'scroll', amount: 0 },
    ]) {
      const { status } = await api.sendDesktopInput(workerId, data);
      expect(status, JSON.stringify(data)).toBe(400);
    }
  });

  test('returns 404 for an unknown worker', async ({ request }) => {
    const api = new ApiClient(request);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await api.getDesktopScreenshot(unknown)).status).toBe(404);
    expect((await api.sendDesktopInput(unknown, { action: 'move', x: 1, y: 1 })).status).toBe(404);
  });
});
