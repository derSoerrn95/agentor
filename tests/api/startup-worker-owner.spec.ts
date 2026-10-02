import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

// After an orchestrator restart, every running worker must be attributed to
// its owner from the first request on. Startup used to sync the running
// containers before the worker store had loaded, so each worker came back
// with an empty userId: the record landed in users/workers.json (the usage
// checker then failed with ENOTDIR on users/workers.json/usage.json, and the
// orphan sweeper deleted it), and worker-self API calls were attributed to no
// user until something re-listed the workers.
//
// Restarts the orchestrator, so it needs the `restart` stack variant, which
// keeps it from running alongside other specs:
//   TEST_STACK_VARIANT=restart npm run test:docker -- --project=api api/startup-worker-owner.spec.ts

const VARIANT = process.env.TEST_STACK_VARIANT;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim();
}

async function waitHealthy(timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('orchestrator did not come back after restart');
}

test.describe.serial('Worker ownership across an orchestrator restart', () => {
  test.skip(VARIANT !== 'restart', 'restarts the orchestrator; needs TEST_STACK_VARIANT=restart');

  let containerId: string;
  let containerName: string;
  let ownerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request);
    containerId = container.id;
    containerName = container.containerName as string;
    ownerId = container.userId as string;
    expect(ownerId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('worker-self resolves the owner right after a restart', async () => {
    const since = new Date().toISOString();
    docker('restart', 'agentor-orchestrator');
    await waitHealthy();

    // Straight from the worker, before any dashboard/API call could re-list
    // (and thereby re-sync) the workers.
    const raw = docker('exec', containerName, 'sh', '-c',
      'curl -s -w "\\n%{http_code}" "$ORCHESTRATOR_URL/api/worker-self/info"');
    const [body, code] = [raw.slice(0, raw.lastIndexOf('\n')), raw.slice(raw.lastIndexOf('\n') + 1)];
    expect(code).toBe('200');
    const info = JSON.parse(body);
    expect(info.workerId).toBe(containerId);
    expect(info.userId).toBe(ownerId);

    // No ownerless record was written.
    const users = docker('exec', 'agentor-orchestrator', 'ls', '/data/users').split('\n');
    expect(users).not.toContain('workers.json');

    // ...and nothing tripped over one.
    const logs = docker('logs', '--since', since, 'agentor-orchestrator');
    expect(logs).not.toContain('ENOTDIR');
    expect(logs).not.toMatch(/orphan-sweeper\] cleaned up/);
  });
});
