defineRouteMeta({
  openAPI: {
    tags: ['Instructions'],
    summary: 'List instructions',
    description: 'Returns all instructions (built-in and custom).',
    operationId: 'listInstructions',
    responses: {
      200: {
        description: 'Array of instructions',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: '#/components/schemas/Instruction' },
            },
          },
        },
      },
    },
    $global: {
      components: {
        schemas: {
          InstructionInput: {
            type: 'object',
            description: "AGENTS.md-style markdown merged into the agents' global instructions (CLAUDE.md, AGENTS.md, GEMINI.md) of workers whose environment enables it.",
            properties: {
              name: { type: 'string', description: 'Unique instruction name' },
              content: { type: 'string', description: 'Markdown instructions for the agents' },
            },
          },
          Instruction: {
            type: 'object',
            allOf: [
              { $ref: '#/components/schemas/InstructionInput' },
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

import { useInstructionStore } from '../../utils/services';
import { requireAuth } from '../../utils/auth-helpers';

export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const all = useInstructionStore().list();
  if (user.role === 'admin') return all;
  return all.filter((i) => i.userId === null || i.userId === user.id);
});
