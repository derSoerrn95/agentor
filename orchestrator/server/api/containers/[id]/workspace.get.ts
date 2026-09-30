defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Download workspace',
    description: 'Downloads the workspace directory (`/workspace`) — or a file / sub-directory of it — as a .tar.gz archive. Entries are prefixed with the basename of the downloaded path (e.g. `workspace/...`).',
    operationId: 'downloadWorkspace',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' },
      { name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: 'File or directory to download, relative to /workspace (or absolute inside it). Default: the whole workspace.' },
    ],
    responses: {
      200: { description: 'Workspace archive', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
      400: { description: 'Path outside the workspace', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Container or path not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { posix } from 'node:path';
import { pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { resolveWorkspacePath, WORKSPACE_ROOT } from '../../../utils/validation';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();

  const info = containerManager.get(id);
  requireContainerAccess(event, info);
  if (!info) {
    throw createError({ statusCode: 404, statusMessage: 'Container not found' });
  }

  const rawPath = getQuery(event).path;
  const workspacePath = typeof rawPath === 'string' && rawPath.trim() ? resolveWorkspacePath(rawPath) : WORKSPACE_ROOT;
  if (!workspacePath) {
    throw createError({ statusCode: 400, statusMessage: 'path must be inside /workspace' });
  }

  const label = workspacePath === WORKSPACE_ROOT ? 'workspace' : posix.basename(workspacePath);
  const safeName = `${info.displayName || id.slice(0, 12)}-${label}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  let tarStream: NodeJS.ReadableStream;
  try {
    tarStream = await containerManager.downloadWorkspace(id, workspacePath);
  } catch (err) {
    // dockerode surfaces a missing path as a 404 from the Docker API.
    if ((err as { statusCode?: number })?.statusCode === 404) {
      throw createError({ statusCode: 404, statusMessage: `No such file or directory: ${workspacePath}` });
    }
    throw err;
  }
  const gzip = createGzip();
  // Docker holds the container's lock while an archive stream is open, so an
  // abandoned download (client gone) must end it — or every later exec on the
  // worker hangs. pipeline() destroys both streams when either side closes.
  pipeline(tarStream as Readable, gzip, () => {});
  event.node.res.once('close', () => gzip.destroy());

  setResponseHeaders(event, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${safeName}.tar.gz"`,
    'Transfer-Encoding': 'chunked',
  });

  return sendStream(event, gzip);
});
