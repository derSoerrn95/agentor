defineRouteMeta({
  openAPI: {
    tags: ['Account'],
    summary: 'List authorized applications',
    description: 'Returns the OAuth applications (MCP clients such as Claude Code or other agents) the current user has authorized to access their Agentor account.',
    operationId: 'listAuthorizedApps',
    responses: {
      200: {
        description: 'Authorized applications',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  clientId: { type: 'string' },
                  name: { type: 'string' },
                  uri: { type: 'string' },
                  scopes: { type: 'array', items: { type: 'string' } },
                  authorizedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  },
});

import { requireAuth } from '../../../utils/auth-helpers';
import { listAuthorizedApps } from '../../../utils/oauth-apps';

export default defineEventHandler((event) => {
  return listAuthorizedApps(requireAuth(event).user.id);
});
