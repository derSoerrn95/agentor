defineRouteMeta({
  openAPI: {
    tags: ['Tmux'],
    summary: 'Read a tmux window',
    description: 'Returns the text currently shown in a tmux window (what a user sees in the terminal pane), optionally with scrollback history. Use it to read the output of an agent CLI or program after sending keys; poll it to wait for progress.',
    operationId: 'captureTmuxWindow',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker ID' },
      { name: 'windowIndex', in: 'path', required: true, schema: { type: 'integer', minimum: 0 }, description: 'tmux window index (0 = main window)' },
      { name: 'history', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 10000 }, description: 'Scrollback lines to include above the visible screen (default 0)' },
    ],
    responses: {
      200: { description: 'Window content', content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' } } } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Worker or window not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Worker not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager } from '../../../../../utils/services';
import { requireRunningContainerAccess } from '../../../../../utils/auth-helpers';
import { rethrowTmuxError } from '../../../../../utils/http-errors';

const MAX_HISTORY_LINES = 10_000;

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireRunningContainerAccess(event, containerManager.get(id));

  const windowIndex = Number(getRouterParam(event, 'windowIndex'));
  if (!Number.isInteger(windowIndex) || windowIndex < 0) {
    throw createError({ statusCode: 400, statusMessage: 'windowIndex must be a non-negative integer' });
  }
  const rawHistory = getQuery(event).history;
  const history = rawHistory === undefined ? 0 : Number(rawHistory);
  if (!Number.isInteger(history) || history < 0 || history > MAX_HISTORY_LINES) {
    throw createError({ statusCode: 400, statusMessage: `history must be an integer between 0 and ${MAX_HISTORY_LINES}` });
  }

  try {
    return { content: await containerManager.captureTmuxWindow(id, windowIndex, history) };
  } catch (err) {
    rethrowTmuxError(err);
  }
});
