defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Execute a command in a worker',
    description: 'Runs a bash command inside a running worker as the `agent` user (passwordless sudo available; the agent CLIs are on PATH) and returns its exit code, stdout and stderr once it finishes. The command runs outside tmux, starting in `/workspace` unless `cwd` is given, and is killed after `timeoutSeconds`. Each output stream is capped at 1 MiB (`truncated` reports dropped output). Use tmux windows for long-running or interactive processes.',
    operationId: 'execCommand',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker ID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['command'],
            properties: {
              command: { type: 'string', description: 'Bash command line, e.g. `git status && ls -la`' },
              cwd: { type: 'string', description: 'Absolute working directory (default /workspace)' },
              timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Kill the command after this many seconds (default 60, max 600)' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Command result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                exitCode: { type: 'integer', description: 'Process exit code (-1 if it could not be determined)' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                truncated: { type: 'boolean', description: 'Output beyond the per-stream cap was dropped' },
                timedOut: { type: 'boolean', description: 'The command hit its timeout and was killed' },
                durationMs: { type: 'integer' },
              },
            },
          },
        },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Worker not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Worker not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager } from '../../../utils/services';
import { EXEC_MAX_TIMEOUT_SECONDS } from '../../../utils/container';
import { requireRunningContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireRunningContainerAccess(event, containerManager.get(id));

  const body = (await readBody(event)) ?? {};
  if (typeof body.command !== 'string' || !body.command.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'command is required' });
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/'))) {
    throw createError({ statusCode: 400, statusMessage: 'cwd must be an absolute path' });
  }
  if (body.timeoutSeconds !== undefined
    && (!Number.isInteger(body.timeoutSeconds) || body.timeoutSeconds < 1 || body.timeoutSeconds > EXEC_MAX_TIMEOUT_SECONDS)) {
    throw createError({ statusCode: 400, statusMessage: `timeoutSeconds must be an integer between 1 and ${EXEC_MAX_TIMEOUT_SECONDS}` });
  }

  try {
    return await containerManager.execCommand(id, body.command, { cwd: body.cwd, timeoutSeconds: body.timeoutSeconds });
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
