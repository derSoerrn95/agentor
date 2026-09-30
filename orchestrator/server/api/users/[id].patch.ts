defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Update user',
    description: 'Changes a user\'s name, email and/or role (admin only). Only the fields present are changed.',
    operationId: 'updateUser',
    'x-admin-only': true,
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'User ID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'user'] },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      403: { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Email already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAdmin } from '../../utils/auth-helpers';
import { isUserRole, updateUser } from '../../utils/user-admin';

export default defineEventHandler(async (event) => {
  const { user: actor } = requireAdmin(event);
  const id = getRouterParam(event, 'id')!;
  const body = (await readBody(event)) ?? {};
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    throw createError({ statusCode: 400, statusMessage: 'name must be a non-empty string' });
  }
  if (body.email !== undefined && typeof body.email !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'email must be a string' });
  }
  if (body.role !== undefined && !isUserRole(body.role)) {
    throw createError({ statusCode: 400, statusMessage: 'role must be "admin" or "user"' });
  }
  if (id === actor.id && body.role === 'user') {
    throw createError({ statusCode: 400, statusMessage: 'You cannot remove your own admin role' });
  }

  return updateUser(id, { name: body.name?.trim(), email: body.email, role: body.role });
});
