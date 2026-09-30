defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Send mouse / keyboard input to the desktop',
    description: 'Performs one mouse or keyboard action on the worker\'s virtual desktop, like a user operating the Desktop pane. Coordinates are pixels of the 1920x1080 screen (same as the screenshot). Actions: `click` / `double_click` / `right_click` / `middle_click` (at x,y — or the current pointer position when omitted), `move` (x,y), `drag` (x,y → toX,toY), `scroll` (direction up/down/left/right, `amount` steps, optionally at x,y), `type` (text), `key` (xdotool key names separated by spaces, e.g. `Return`, `ctrl+l`, `alt+Tab`, `ctrl+a BackSpace`). Take a screenshot afterwards to see the result.',
    operationId: 'sendDesktopInput',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker ID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag', 'scroll', 'type', 'key'] },
              x: { type: 'integer', minimum: 0, description: 'Pointer x (pixels from the left)' },
              y: { type: 'integer', minimum: 0, description: 'Pointer y (pixels from the top)' },
              toX: { type: 'integer', minimum: 0, description: 'Drag end x' },
              toY: { type: 'integer', minimum: 0, description: 'Drag end y' },
              text: { type: 'string', description: 'Text to type (action `type`)' },
              keys: { type: 'string', description: 'Key combination(s) for action `key`, e.g. `ctrl+l` or `Return`' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down)' },
              amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Scroll steps (default 3)' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Action performed', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Worker not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      409: { description: 'Worker not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import type { DesktopInputAction, DesktopInputActionType } from '../../../../../shared/types';
import { useContainerManager } from '../../../../utils/services';
import { requireRunningContainerAccess } from '../../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

const ACTIONS: readonly DesktopInputActionType[] = ['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag', 'scroll', 'type', 'key'];
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
/** xdotool key names joined by `+`, several combos separated by spaces. */
const KEYS_RE = /^[A-Za-z0-9_+\- ]{1,200}$/;

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}

function isCoordinate(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseAction(body: Record<string, unknown>): DesktopInputAction {
  const action = body.action as DesktopInputActionType;
  if (!ACTIONS.includes(action)) bad(`action must be one of: ${ACTIONS.join(', ')}`);
  for (const field of ['x', 'y', 'toX', 'toY'] as const) {
    if (body[field] !== undefined && !isCoordinate(body[field])) bad(`${field} must be a non-negative integer`);
  }
  if ((body.x === undefined) !== (body.y === undefined)) bad('x and y must be given together');
  const needsPoint = action === 'move' || action === 'drag';
  if (needsPoint && body.x === undefined) bad(`${action} requires x and y`);
  if (action === 'drag' && (body.toX === undefined || body.toY === undefined)) bad('drag requires toX and toY');
  if (action === 'type' && (typeof body.text !== 'string' || !body.text)) bad('type requires a non-empty text');
  if (action === 'key' && (typeof body.keys !== 'string' || !KEYS_RE.test(body.keys.trim()))) {
    bad('key requires keys, e.g. "Return" or "ctrl+l"');
  }
  if (body.direction !== undefined && !DIRECTIONS.includes(body.direction as typeof DIRECTIONS[number])) {
    bad(`direction must be one of: ${DIRECTIONS.join(', ')}`);
  }
  if (body.amount !== undefined && (!Number.isInteger(body.amount) || (body.amount as number) < 1 || (body.amount as number) > 50)) {
    bad('amount must be an integer between 1 and 50');
  }
  return {
    action,
    x: body.x as number | undefined,
    y: body.y as number | undefined,
    toX: body.toX as number | undefined,
    toY: body.toY as number | undefined,
    text: body.text as string | undefined,
    keys: typeof body.keys === 'string' ? body.keys.trim() : undefined,
    direction: body.direction as DesktopInputAction['direction'],
    amount: body.amount as number | undefined,
  };
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireRunningContainerAccess(event, containerManager.get(id));

  const input = parseAction((await readBody(event)) ?? {});
  try {
    await containerManager.sendDesktopInput(id, input);
    return { ok: true };
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
