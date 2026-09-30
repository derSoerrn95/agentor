defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Delete user',
    description: 'Permanently deletes a user account and all of their Agentor data — workers (including workspaces), mappings, custom environments/capabilities/instructions/init scripts, env vars and credentials (admin only). You cannot delete yourself.',
    operationId: 'deleteUser',
    'x-admin-only': true,
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'User ID' }],
    responses: {
      200: { description: 'User deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      400: { description: 'Cannot delete yourself', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      403: { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAdmin } from '../../utils/auth-helpers';
import { deleteUser } from '../../utils/user-admin';

export default defineEventHandler(async (event) => {
  const { user: actor } = requireAdmin(event);
  await deleteUser(getRouterParam(event, 'id')!, actor.id);
  return { ok: true };
});
