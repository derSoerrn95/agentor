import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, uniquePort } from '../helpers/worker-lifecycle';

// TRAEFIK_MODE=external: the orchestrator runs behind a reverse proxy it does
// not manage. Domain mappings must still be accepted and written to
// traefik-config.yml for that proxy, but the orchestrator must never start
// its own Traefik (which would fight the proxy for 80/443).
//
// Needs the `external` stack variant (tests/docker/variants/external.yml):
//   TEST_STACK_VARIANT=external npm run test:docker -- --project=api api/traefik-external.spec.ts

const VARIANT = process.env.TEST_STACK_VARIANT;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim();
}

function traefikContainers(): string[] {
  return docker('ps', '-aq', '--filter', 'label=agentor.managed=traefik').split('\n').filter(Boolean);
}

function traefikConfig(): string {
  return docker('exec', 'agentor-orchestrator', 'cat', '/data/traefik-config.yml');
}

test.describe.serial('Traefik external mode', () => {
  test.skip(VARIANT !== 'external', 'needs TEST_STACK_VARIANT=external');

  let containerId: string;
  let containerName: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request);
    containerId = container.id;
    containerName = container.containerName as string;
  });

  test.afterAll(async ({ request }) => {
    const api = new ApiClient(request);
    const { body: mappings } = await api.listDomainMappings();
    for (const m of mappings ?? []) {
      if (m.containerName === containerName) {
        try { await api.deleteDomainMapping(m.id); } catch { /* ignore */ }
      }
    }
    await cleanupWorker(request, containerId);
  });

  test('settings report TRAEFIK_MODE=external', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.getSettings();
    expect(status).toBe(200);
    const items = body.flatMap((s: { items: { key: string; value: unknown }[] }) => s.items);
    expect(items.find((i: { key: string }) => i.key === 'TRAEFIK_MODE')?.value).toBe('external');
  });

  test('a domain mapping is written to traefik-config.yml without starting Traefik', async ({ request }) => {
    const api = new ApiClient(request);
    const subdomain = `ext-${Date.now().toString(36)}`;
    const { status, body } = await api.createDomainMapping({
      subdomain,
      baseDomain: 'docker.localhost',
      protocol: 'https',
      workerId: containerId,
      internalPort: uniquePort(),
    });
    expect(status).toBe(201);

    await expect.poll(() => traefikConfig(), { timeout: 15_000 }).toContain(`${subdomain}.docker.localhost`);
    expect(traefikContainers()).toEqual([]);

    const del = await api.deleteDomainMapping(body.id);
    expect(del.status).toBe(200);
    await expect.poll(() => traefikConfig(), { timeout: 15_000 }).not.toContain(`${subdomain}.docker.localhost`);
    expect(traefikContainers()).toEqual([]);
  });

  test('a Traefik left over from managed mode is removed on the next apply', async ({ request }) => {
    // Stand-in for the agentor-traefik a previous managed-mode run left
    // behind. Found by its label, like the real one.
    docker('run', '-d', '--name', 'agentor-traefik', '--label', 'agentor.managed=traefik',
      '--entrypoint', 'sleep', 'agentor-orchestrator:latest', '600');
    try {
      expect(traefikContainers()).toHaveLength(1);
      const api = new ApiClient(request);
      const { status, body } = await api.createDomainMapping({
        subdomain: `ext-${Date.now().toString(36)}`,
        baseDomain: 'docker.localhost',
        protocol: 'https',
        workerId: containerId,
        internalPort: uniquePort(),
      });
      expect(status).toBe(201);
      await expect.poll(() => traefikContainers(), { timeout: 15_000 }).toEqual([]);
      await api.deleteDomainMapping(body.id);
    } finally {
      try { docker('rm', '-f', 'agentor-traefik'); } catch { /* already removed */ }
    }
  });

  test('the update checker leaves Traefik alone', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.checkForUpdates();
    expect(status).toBe(200);
    expect(body.traefik).toBeNull();
  });

  test('passkeys are enabled from an https BETTER_AUTH_URL', async ({ request }) => {
    const api = new ApiClient(request);
    const { body } = await api.getSettings();
    const items = body.flatMap((s: { items: { key: string; value: unknown }[] }) => s.items);
    expect(items.find((i: { key: string }) => i.key === 'BETTER_AUTH_RP_ID')?.value).toBe('agentor.docker.localhost (auto)');

    const res = await request.get('/api/auth/passkey/generate-register-options');
    expect(res.status()).toBe(200);
    const options = await res.json();
    expect(options.rp?.id).toBe('agentor.docker.localhost');
  });
});
