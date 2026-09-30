defineRouteMeta({
  openAPI: {
    tags: ['Account'],
    summary: 'Revoke an authorized application',
    description: 'Revokes the current user\'s authorization of an OAuth application (MCP client): its consent, refresh tokens and access tokens are deleted and it is cut off from the MCP server immediately. It has to ask the user for consent again to regain access.',
    operationId: 'revokeAuthorizedApp',
    parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' }, description: 'OAuth client ID (URL-encoded)' }],
    responses: {
      200: { description: 'Revoked', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      404: { description: 'Application not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAuth } from '../../../utils/auth-helpers';
import { revokeAuthorizedApp } from '../../../utils/oauth-apps';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const clientId = getRouterParam(event, 'clientId', { decode: true })!;
  if (!(await revokeAuthorizedApp(user.id, clientId))) {
    throw createError({ statusCode: 404, statusMessage: 'Application not authorized' });
  }
  return { ok: true };
});
