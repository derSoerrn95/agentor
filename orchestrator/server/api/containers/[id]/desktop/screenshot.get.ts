defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Take a desktop screenshot',
    description: 'Captures the worker\'s virtual desktop (the display shown in the dashboard\'s Desktop pane, 1920x1080) as a PNG image — browsers and other GUI apps started in the worker render there. Pair with the desktop input endpoint to operate GUI apps.',
    operationId: 'getDesktopScreenshot',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker ID' }],
    responses: {
      200: { description: 'PNG screenshot', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
      404: { description: 'Worker not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Worker not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager } from '../../../../utils/services';
import { requireRunningContainerAccess } from '../../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireRunningContainerAccess(event, containerManager.get(id));

  try {
    const png = await containerManager.captureDesktopScreenshot(id);
    setResponseHeaders(event, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return png;
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
