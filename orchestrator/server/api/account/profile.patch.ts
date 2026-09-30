defineRouteMeta({
  openAPI: {
    tags: ['Account'],
    summary: 'Update the current user\'s profile',
    description: 'Changes the signed-in user\'s name and/or email. The name and email are also the git identity of every worker the user creates or rebuilds afterwards.',
    operationId: 'updateAccountProfile',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Email already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAuth } from '../../utils/auth-helpers';
import { updateUser } from '../../utils/user-admin';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const body = (await readBody(event)) ?? {};
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    throw createError({ statusCode: 400, statusMessage: 'name must be a non-empty string' });
  }
  if (body.email !== undefined && typeof body.email !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'email must be a string' });
  }
  if (body.name === undefined && body.email === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Provide name and/or email' });
  }
  return updateUser(user.id, { name: body.name?.trim(), email: body.email });
});
