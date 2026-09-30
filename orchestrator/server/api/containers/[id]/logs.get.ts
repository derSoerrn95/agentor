defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Get container logs',
    description: 'Returns the tail of a worker container\'s stdout/stderr: the startup sequence (repo cloning, setup script, display stack, …) and background services. Output of programs in tmux windows is not included — read that with the tmux capture endpoint.',
    operationId: 'getContainerLogs',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' },
      { name: 'tail', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000 }, description: 'Number of most recent lines (default 200, max 10000)' },
    ],
    responses: {
      200: { description: 'Container logs', content: { 'application/json': { schema: { type: 'object', properties: { logs: { type: 'string' } } } } } },
      404: { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const query = getQuery(event);
  const parsed = query.tail ? parseInt(query.tail as string, 10) : 200;
  const tail = isNaN(parsed) || parsed < 1 ? 200 : Math.min(parsed, 10000);
  const containerManager = useContainerManager();
  requireContainerAccess(event, containerManager.get(id));
  const logs = await containerManager.logs(id, tail);
  return { logs };
});
