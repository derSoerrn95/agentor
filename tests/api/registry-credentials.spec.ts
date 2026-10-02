import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

// Private registries: the orchestrator authenticates its own pulls and update
// checks with REGISTRY_CREDENTIALS, or with a docker config.json.
//
// Needs the `registry` stack variant (tests/docker/variants/registry.{yml,sh}):
//   TEST_STACK_VARIANT=registry npm run test:docker -- --project=api api/registry-credentials.spec.ts
// It runs a registry:2 with htpasswd auth that answers as
//   registry.localhost:5443   (worker images; REGISTRY_CREDENTIALS)
//   registry2.localhost:5443  (ORCHESTRATOR_IMAGE; config.json only)
// The runner's docker CLI holds no credentials, so every successful pull or
// check below went through the orchestrator's own authentication.

const VARIANT = process.env.TEST_STACK_VARIANT;
const REGISTRY = 'registry.localhost:5443';
const REG_USER = 'agentor';
const REG_PASS = 'agentor-test-registry-pw';
const WORKER_IMAGE = `${REGISTRY}/agentor-worker:latest`;
const ORCHESTRATOR_IMAGE = 'registry2.localhost:5443/agentor-orchestrator:latest';

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, { encoding: 'utf-8', input }).trim();
}

function hasLocalImage(ref: string): boolean {
  return docker(['images', '-q', ref]) !== '';
}

/** Push a new revision of the worker image, so the registry digest moves on,
 * while the local tag stays on the current image — as on a real host. The new
 * image is removed locally, so the update has to pull it. */
function pushNewWorkerRevision(): void {
  const current = docker(['image', 'inspect', '-f', '{{.Id}}', WORKER_IMAGE]);
  const next = docker(['build', '-q', '-t', WORKER_IMAGE, '-'],
    `FROM agentor-worker:latest\nLABEL agentor.test.revision="${Date.now()}"\n`);
  docker(['login', REGISTRY, '-u', REG_USER, '--password-stdin'], REG_PASS);
  try {
    docker(['push', '-q', WORKER_IMAGE]);
  } finally {
    docker(['logout', REGISTRY]);
  }
  docker(['tag', current, WORKER_IMAGE]);
  docker(['rmi', next]);
}

test.describe.serial('Private registry credentials', () => {
  test.skip(VARIANT !== 'registry', 'needs TEST_STACK_VARIANT=registry');

  let containerId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (containerId) await cleanupWorker(request, containerId);
  });

  test('update check authenticates against both credential sources', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.checkForUpdates();
    expect(status).toBe(200);

    // REGISTRY_CREDENTIALS (registry.localhost)
    expect(body.worker?.name).toBe(WORKER_IMAGE);
    expect(body.worker?.error).toBeUndefined();
    expect(body.worker?.remoteDigest).toMatch(/^sha256:/);

    // config.json (registry2.localhost) — and the fully qualified
    // ORCHESTRATOR_IMAGE is used as-is, not prefixed with WORKER_IMAGE_PREFIX.
    expect(body.orchestrator?.name).toBe(ORCHESTRATOR_IMAGE);
    expect(body.orchestrator?.error).toBeUndefined();
    expect(body.orchestrator?.remoteDigest).toMatch(/^sha256:/);
  });

  test('creating a worker pulls its image from the private registry', async ({ request }) => {
    expect(hasLocalImage(WORKER_IMAGE)).toBe(false);
    const container = await createWorker(request);
    containerId = container.id;
    expect(container.imageName).toBe(WORKER_IMAGE);
    expect(hasLocalImage(WORKER_IMAGE)).toBe(true);

    // Pulled image == registry image: nothing to update.
    const api = new ApiClient(request);
    const { body } = await api.checkForUpdates();
    expect(body.worker?.error).toBeUndefined();
    expect(body.worker?.localDigest).toBe(body.worker?.remoteDigest);
    expect(body.worker?.updateAvailable).toBe(false);
  });

  test('a new image in the private registry is detected and pulled by the update', async ({ request }) => {
    pushNewWorkerRevision();
    const api = new ApiClient(request);

    const { body: before } = await api.checkForUpdates();
    expect(before.worker?.error).toBeUndefined();
    expect(before.worker?.updateAvailable).toBe(true);

    const { status, body: applied } = await api.applyUpdates(['worker']);
    expect(status).toBe(200);
    expect(applied.errors ?? []).toEqual([]);
    expect(applied.workerPulled).toBe(true);

    const { body: after } = await api.checkForUpdates();
    expect(after.worker?.updateAvailable).toBe(false);
    expect(after.worker?.localDigest).toBe(before.worker?.remoteDigest);
  });
});
