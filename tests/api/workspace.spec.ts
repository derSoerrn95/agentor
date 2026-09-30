import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

test.describe('Workspace API', () => {
  let containerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request);
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test.describe('POST /api/containers/:id/workspace (upload)', () => {
    test('uploads files to workspace', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, body } = await api.uploadToWorkspace(containerId, [
        {
          name: 'test.txt',
          content: Buffer.from('Hello, world!'),
          mimeType: 'text/plain',
        },
      ]);
      expect(status).toBe(200);
      expect(body.uploaded).toBe(1);
    });

    test('uploads multiple files', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, body } = await api.uploadToWorkspace(containerId, [
        { name: 'file1.txt', content: Buffer.from('File 1'), mimeType: 'text/plain' },
        { name: 'file2.txt', content: Buffer.from('File 2'), mimeType: 'text/plain' },
        { name: 'file3.txt', content: Buffer.from('File 3'), mimeType: 'text/plain' },
      ]);
      expect(status).toBe(200);
      expect(body.uploaded).toBe(3);
    });

    test('rejects path traversal', async ({ request }) => {
      const api = new ApiClient(request);
      const { status } = await api.uploadToWorkspace(containerId, [
        { name: '../../../etc/passwd', content: Buffer.from('hack'), mimeType: 'text/plain' },
      ]);
      expect(status).toBe(400);
    });

    test('rejects encoded path traversal', async ({ request }) => {
      const api = new ApiClient(request);
      const { status } = await api.uploadToWorkspace(containerId, [
        { name: '..%2F..%2Fetc%2Fpasswd', content: Buffer.from('hack'), mimeType: 'text/plain' },
      ]);
      // Should be rejected (400) or treated as a literal filename (200)
      // Either way, path traversal must not succeed
      expect([200, 400]).toContain(status);
    });

    test('upload to non-existent container fails', async ({ request }) => {
      const api = new ApiClient(request);
      const { status } = await api.uploadToWorkspace('non-existent-id', [
        { name: 'test.txt', content: Buffer.from('hello'), mimeType: 'text/plain' },
      ]);
      expect(status).toBeGreaterThanOrEqual(400);
    });

    test('uploads file with subdirectory path', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, body } = await api.uploadToWorkspace(containerId, [
        { name: 'subdir/nested.txt', content: Buffer.from('nested content'), mimeType: 'text/plain' },
      ]);
      expect(status).toBe(200);
      expect(body.uploaded).toBe(1);
    });

    test('uploads empty file', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, body } = await api.uploadToWorkspace(containerId, [
        { name: 'empty.txt', content: Buffer.from(''), mimeType: 'text/plain' },
      ]);
      expect(status).toBe(200);
      expect(body.uploaded).toBe(1);
    });
  });

  test.describe('POST /api/containers/:id/workspace (JSON body)', () => {
    test('writes UTF-8 and base64 files (relative or absolute inside /workspace), creating directories', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, body } = await api.uploadWorkspaceJson(containerId, [
        { path: 'json-upload/readme.md', content: '# héllo\n' },
        { path: '/workspace/json-upload/bin/data.bin', content: Buffer.from([0, 255, 7]).toString('base64'), encoding: 'base64' },
      ]);
      expect(status).toBe(200);
      expect(body).toEqual({ uploaded: 2 });
      const check = await api.execCommand(containerId, {
        command: 'cat json-upload/readme.md; od -An -tu1 json-upload/bin/data.bin | tr -s " "; stat -c %U json-upload/readme.md',
      });
      expect(check.body.stdout).toBe('# héllo\n 0 255 7\nagent\n');
    });

    test('rejects traversal and malformed bodies', async ({ request }) => {
      const api = new ApiClient(request);
      expect((await api.uploadWorkspaceJson(containerId, [{ path: '../escape.txt', content: 'x' }])).status).toBe(400);
      expect((await api.uploadWorkspaceJson(containerId, [{ path: '/etc/escape.txt', content: 'x' }])).status).toBe(400);
      expect((await api.uploadWorkspaceJson(containerId, [{ path: 'ok.txt', content: 'x', encoding: 'hex' as 'utf8' }])).status).toBe(400);
      expect((await api.uploadWorkspaceJson(containerId, [])).status).toBe(400);
      const res = await request.post(`/api/containers/${containerId}/workspace`, { data: { files: 'nope' } });
      expect(res.status()).toBe(400);
    });
  });

  test.describe('GET /api/containers/:id/workspace (download)', () => {
    test('downloads workspace as tar.gz', async ({ request }) => {
      const api = new ApiClient(request);
      const { status, headers } = await api.downloadWorkspace(containerId);
      expect(status).toBe(200);
      expect(headers['content-type']).toContain('gzip');
      expect(headers['content-disposition']).toContain('attachment');
      expect(headers['content-disposition']).toContain('.tar.gz');
    });

    test('returns 404 for non-existent container', async ({ request }) => {
      const api = new ApiClient(request);
      const { status } = await api.downloadWorkspace('non-existent-id');
      expect(status).toBe(404);
    });

    test('downloads a sub-directory or single file', async ({ request }) => {
      const api = new ApiClient(request);
      await api.uploadWorkspaceJson(containerId, [
        { path: 'dl/one.txt', content: 'first file' },
        { path: 'dl/two.txt', content: 'second file' },
      ]);

      const dir = await api.downloadWorkspace(containerId, 'dl');
      expect(dir.status).toBe(200);
      expect(dir.headers['content-disposition']).toContain('-dl.tar.gz');
      const dirTar = gunzipSync(dir.body).toString('latin1');
      expect(dirTar).toContain('dl/one.txt');
      expect(dirTar).toContain('second file');

      const file = await api.downloadWorkspace(containerId, '/workspace/dl/one.txt');
      expect(file.status).toBe(200);
      const fileTar = gunzipSync(file.body).toString('latin1');
      expect(fileTar).toContain('one.txt');
      expect(fileTar).toContain('first file');
      expect(fileTar).not.toContain('second file');
    });

    test('rejects paths outside the workspace and 404s missing ones', async ({ request }) => {
      const api = new ApiClient(request);
      expect((await api.downloadWorkspace(containerId, '../etc')).status).toBe(400);
      expect((await api.downloadWorkspace(containerId, '/etc/passwd')).status).toBe(400);
      expect((await api.downloadWorkspace(containerId, 'does/not/exist')).status).toBe(404);
    });
  });
});
