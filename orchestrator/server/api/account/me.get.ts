defineRouteMeta({
  openAPI: {
    tags: ['Account'],
    summary: 'Get the current user',
    description: 'Returns the signed-in user (id, name, email, role). The `id` is the `userId` stamped on every resource the user owns; `role: admin` unlocks user management and system administration.',
    operationId: 'getCurrentUser',
    responses: {
      200: { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAuth } from '../../utils/auth-helpers';
import { getUser } from '../../utils/user-admin';

export default defineEventHandler((event) => {
  return getUser(requireAuth(event).user.id);
});
