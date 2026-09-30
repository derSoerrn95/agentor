defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Set user password',
    description: 'Sets (or resets) another user\'s password without knowing the current one (admin only). Your own password is changed in the account settings, which require the current password.',
    operationId: 'setUserPassword',
    'x-admin-only': true,
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'User ID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['newPassword'],
            properties: { newPassword: { type: 'string', description: 'At least 8 characters' } },
          },
        },
      },
    },
    responses: {
      200: { description: 'Password set', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      400: { description: 'Validation error or own account', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      403: { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { requireAdmin } from '../../../utils/auth-helpers';
import { setUserPassword } from '../../../utils/user-admin';

export default defineEventHandler(async (event) => {
  const { user: actor } = requireAdmin(event);
  const id = getRouterParam(event, 'id')!;
  if (id === actor.id) {
    throw createError({ statusCode: 400, statusMessage: 'Change your own password in your account settings' });
  }
  const body = (await readBody(event)) ?? {};
  if (typeof body.newPassword !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'newPassword is required' });
  }
  await setUserPassword(id, body.newPassword);
  return { ok: true };
});
