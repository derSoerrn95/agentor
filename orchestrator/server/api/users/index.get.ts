defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'List users',
    description: 'Returns every user account (admin only).',
    operationId: 'listUsers',
    'x-admin-only': true,
    responses: {
      200: { description: 'Array of users', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } },
      403: { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
    $global: {
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'User UUID — the `userId` on every resource the user owns' },
              name: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'user'] },
              emailVerified: { type: 'boolean' },
              banned: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
});

import { requireAdmin } from '../../utils/auth-helpers';
import { listUsers } from '../../utils/user-admin';

export default defineEventHandler((event) => {
  requireAdmin(event);
  return listUsers();
});
