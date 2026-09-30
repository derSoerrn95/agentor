defineRouteMeta({
  openAPI: {
    tags: ['Init Scripts'],
    summary: 'List init scripts',
    description: 'Returns all init scripts (built-in and custom).',
    operationId: 'listInitScripts',
    responses: {
      200: {
        description: 'Array of init scripts',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: '#/components/schemas/InitScript' },
            },
          },
        },
      },
    },
    $global: {
      components: {
        schemas: {
          InitScriptInput: {
            type: 'object',
            description: "Reusable bash script offered as a worker's init script — the program started in tmux window 0 when the worker starts (e.g. launching an agent CLI). Pass its `content` as `initScript` when creating a worker.",
            properties: {
              name: { type: 'string', description: 'Unique init script name' },
              content: { type: 'string', description: 'Bash script (a shebang line is optional)' },
            },
          },
          InitScript: {
            type: 'object',
            allOf: [
              { $ref: '#/components/schemas/InitScriptInput' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  builtIn: { type: 'boolean', description: 'Platform-provided; read-only' },
                  userId: { type: 'string', nullable: true, description: 'Owner (null for built-ins)' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            ],
          },
        },
      },
    },
  },
});

import { useInitScriptStore } from '../../utils/services';
import type { InitScriptInfo } from '../../../shared/types';
import { requireAuth } from '../../utils/auth-helpers';

export default defineEventHandler((event): InitScriptInfo[] => {
  const { user } = requireAuth(event);
  const all = useInitScriptStore().list();
  if (user.role === 'admin') return all;
  return all.filter((s) => s.userId === null || s.userId === user.id);
});
