defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Upload to workspace',
    description: 'Writes files into the workspace directory (`/workspace`) of a running worker, creating parent directories and overwriting existing files. Send `multipart/form-data` (each part\'s filename is its path relative to /workspace — what the dashboard uses) or JSON `{ files: [{ path, content, encoding }] }` with UTF-8 text or base64 content.',
    operationId: 'uploadToWorkspace',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['files'],
            properties: {
              files: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['path', 'content'],
                  properties: {
                    path: { type: 'string', description: 'Destination path relative to /workspace (e.g. `src/app.ts`) or absolute inside it' },
                    content: { type: 'string', description: 'File content' },
                    encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding of `content` (default utf8)' },
                  },
                },
              },
            },
          },
        },
        'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } },
      },
    },
    responses: {
      200: { description: 'Upload result', content: { 'application/json': { schema: { type: 'object', properties: { uploaded: { type: 'integer', description: 'Number of files written' } } } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import * as tar from 'tar-stream';
import type { H3Event } from 'h3';
import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { resolveWorkspacePath, WORKSPACE_ROOT } from '../../../utils/validation';

interface UploadEntry {
  path: string;
  data: Buffer;
}

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}

/** Tar entry name relative to /workspace. Accepts a path relative to, or
 * absolute inside, the workspace (like the download route); anything that
 * resolves outside it is rejected. */
function sanitizePath(path: string): string {
  if (path.split('/').includes('..')) bad('Path traversal not allowed');
  const resolved = resolveWorkspacePath(path);
  if (!resolved) bad(`Path must be inside ${WORKSPACE_ROOT}: ${path}`);
  if (resolved === WORKSPACE_ROOT) bad('File path must not be empty');
  return resolved.slice(WORKSPACE_ROOT.length + 1);
}

async function readMultipartEntries(event: H3Event): Promise<UploadEntry[]> {
  const formData = await readMultipartFormData(event);
  return (formData ?? [])
    .filter((part) => part.filename && part.data)
    .map((part) => ({ path: sanitizePath(part.filename!), data: part.data }));
}

async function readJsonEntries(event: H3Event): Promise<UploadEntry[]> {
  const body = await readBody(event);
  if (!Array.isArray(body?.files)) bad('files must be an array');
  return body.files.map((file: Record<string, unknown>) => {
    if (typeof file?.path !== 'string') bad('each file needs a string path');
    if (typeof file.content !== 'string') bad('each file needs a string content');
    const encoding = file.encoding ?? 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') bad('encoding must be "utf8" or "base64"');
    return { path: sanitizePath(file.path), data: Buffer.from(file.content, encoding) };
  });
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireContainerAccess(event, containerManager.get(id));

  const isJson = (getHeader(event, 'content-type') ?? '').includes('application/json');
  const entries = isJson ? await readJsonEntries(event) : await readMultipartEntries(event);
  if (entries.length === 0) bad('No files provided');

  const pack = tar.pack();
  for (const entry of entries) {
    pack.entry({ name: entry.path, size: entry.data.length, uid: 1000, gid: 1000 }, entry.data);
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer);
  }
  await containerManager.uploadToWorkspace(id, Buffer.concat(chunks));

  return { uploaded: entries.length };
});
