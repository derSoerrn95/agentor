defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Create user',
    description: 'Creates a user account (admin only). Without a password the user can only sign in once a password is set for them or they register a passkey.',
    operationId: 'createUser',
    'x-admin-only': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'email'],
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
              password: { type: 'string', description: 'Initial password (min 8 characters)' },
              role: { type: 'string', enum: ['admin', 'user'], description: 'Default user' },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Created user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      403: { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Email already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAdmin } from '../../utils/auth-helpers';
import { createUser, isUserRole } from '../../utils/user-admin';

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = (await readBody(event)) ?? {};
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'name is required' });
  }
  if (typeof body.email !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'email is required' });
  }
  if (body.password !== undefined && typeof body.password !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'password must be a string' });
  }
  if (body.role !== undefined && !isUserRole(body.role)) {
    throw createError({ statusCode: 400, statusMessage: 'role must be "admin" or "user"' });
  }

  const user = await createUser({ name: body.name.trim(), email: body.email, password: body.password, role: body.role ?? 'user' });
  setResponseStatus(event, 201);
  return user;
});
