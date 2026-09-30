import { OpenAPIToolGenerator, buildHttpRequest, toSdkTool } from 'mcp-from-openapi';
import type { McpOpenAPITool } from 'mcp-from-openapi';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult, JsonSchemaType, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { AuthContext } from './auth-helpers';
import { INTERNAL_AUTH_HEADER, issueInternalAuthToken } from './internal-auth';

/**
 * OpenAPI → MCP tool bridge.
 *
 * Every documented REST route (a `defineRouteMeta` with an `operationId`)
 * becomes an MCP tool automatically — the OpenAPI spec Nitro generates from
 * the route metadata is the single source of truth. A tool call is executed by
 * re-dispatching the equivalent HTTP request to the real route over loopback
 * (`LOCAL_ORIGIN`), authenticated as the MCP caller, so validation, ownership
 * checks and side effects are exactly those of the REST API.
 *
 * Route-level controls (OpenAPI extensions in `defineRouteMeta({ openAPI })`):
 *   - `'x-mcp': false` — keep the route out of MCP (the `x-mcp` family is
 *     interpreted by `mcp-from-openapi`: `{ name, title, description, annotations }`
 *     overrides are supported too).
 *   - `'x-admin-only': true` — only list the tool for admin users (the route
 *     itself must still enforce `requireAdmin`).
 */

const OPENAPI_SPEC_PATH = '/api/docs/openapi.json';

/** The orchestrator's own listener. Tool calls go through real loopback HTTP
 * rather than Nitro's `localFetch`, whose mock response buffers the whole body
 * with a copy per chunk — a large workspace download would stall the event
 * loop before any size limit could apply. */
export const LOCAL_ORIGIN = `http://127.0.0.1:${process.env.NITRO_PORT || process.env.PORT || 3000}`;

/** Tags whose routes are never exposed: worker-internal (source-IP auth),
 * first-run setup, the unauthenticated health probe, and the browser-only
 * proxy / WebSocket routes. */
const EXCLUDED_TAGS = ['Worker Self', 'Setup', 'Health', 'Internal'];

/** Responses above this size are refused (the body is read as a stream and
 * abandoned at the limit) instead of being inlined into the MCP result. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface ApiTool {
  tool: McpOpenAPITool;
  /** `registerTool` arguments, prepared once — servers are built per request. */
  name: string;
  config: Omit<ReturnType<typeof toSdkTool<StandardSchemaWithJSON>>[1], 'outputSchema'>;
  adminOnly: boolean;
}

type OpenApiSpec = { paths?: Record<string, Record<string, Record<string, unknown>>> };

let toolsPromise: Promise<ApiTool[]> | null = null;

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

async function generateApiTools(): Promise<ApiTool[]> {
  const res = await useNitroApp().localFetch(OPENAPI_SPEC_PATH);
  if (!res.ok) throw new Error(`failed to load ${OPENAPI_SPEC_PATH}: HTTP ${res.status}`);
  const spec = (await res.json()) as OpenApiSpec;

  const generator = await OpenAPIToolGenerator.fromJSON(spec, {
    // Nitro emits OpenAPI-3.0 style keywords (e.g. `nullable`) in a 3.1
    // document; generation normalizes them, strict validation would reject.
    validate: false,
  });
  const tools = await generator.generateTools({
    includePaths: ['/api/**'],
    excludeTags: EXCLUDED_TAGS,
    // Only documented routes: a handler without `defineRouteMeta` has no operationId.
    filterFn: (operation) => !!operation.operationId,
    descriptionStrategy: 'combined',
    // "Returns: object with fields: …" from the success response schema.
    appendResponseSummary: true,
    includeAllResponses: false,
    target: 'strict',
    namingStrategy: {
      toolNameGenerator: (path, method, operationId) => snakeCase(operationId ?? `${method}_${path}`),
    },
  });

  return tools.map((tool) => {
    const operation = spec.paths?.[tool.metadata.path]?.[tool.metadata.method];
    // Route response schemas are documentation, not a contract the results are
    // validated against — advertising them as `outputSchema` would oblige every
    // result to carry conforming `structuredContent`.
    const [name, { outputSchema: _outputSchema, ...config }] = toSdkTool(tool, {
      // Both libraries model the same JSON Schema with slightly different types.
      fromJsonSchema: (schema) => fromJsonSchema(schema as JsonSchemaType),
    });
    return { tool, name, config, adminOnly: operation?.['x-admin-only'] === true };
  });
}

/** The generated tool set, built once per process from the live OpenAPI spec. */
export function loadApiTools(): Promise<ApiTool[]> {
  toolsPromise ??= generateApiTools().catch((err) => {
    toolsPromise = null;
    throw err;
  });
  return toolsPromise;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function mediaType(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}

function isJson(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json');
}

function isText(type: string): boolean {
  return type.startsWith('text/') || type === 'application/x-pem-file' || type === 'application/x-yaml';
}

function attachmentName(res: Response): string | undefined {
  return res.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1];
}

/** Reads the body up to `limit` bytes; null (and the stream cancelled) beyond it. */
async function readBodyCapped(res: Response, limit: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

function errorMessage(body: Buffer, fallback: string): string {
  const text = body.toString('utf8');
  try {
    const parsed = JSON.parse(text) as { statusMessage?: string; message?: string };
    return parsed.statusMessage || parsed.message || text;
  } catch {
    return text || fallback;
  }
}

/** Maps the route's HTTP response onto MCP content: JSON/text → text, images →
 * image content, any other binary → an embedded blob resource. */
async function toToolResult(res: Response, tool: McpOpenAPITool): Promise<CallToolResult> {
  const type = mediaType(res);
  const body = await readBodyCapped(res, MAX_RESPONSE_BYTES);
  if (!body) {
    return errorResult(
      `The ${type || 'response'} body exceeds the ${MAX_RESPONSE_BYTES}-byte MCP limit. `
      + 'Narrow the request (e.g. a sub-path) or inspect the data with exec_command instead.',
    );
  }
  if (!res.ok) {
    return errorResult(`HTTP ${res.status}: ${errorMessage(body, res.statusText)}`);
  }
  if (body.length === 0) {
    return { content: [{ type: 'text', text: 'OK' }] };
  }
  if (!type || isJson(type)) {
    const text = body.toString('utf8');
    try {
      return { content: [{ type: 'text', text: JSON.stringify(JSON.parse(text), null, 2) }] };
    } catch {
      return { content: [{ type: 'text', text }] };
    }
  }
  if (isText(type)) {
    return { content: [{ type: 'text', text: body.toString('utf8') }] };
  }

  const data = body.toString('base64');
  if (type.startsWith('image/')) {
    return { content: [{ type: 'image', data, mimeType: type }] };
  }
  const filename = attachmentName(res) ?? `${tool.name}.bin`;
  return {
    content: [
      { type: 'text', text: `${filename} (${type}, ${body.length} bytes)` },
      { type: 'resource', resource: { uri: `agentor://download/${encodeURIComponent(filename)}`, mimeType: type, blob: data } },
    ],
  };
}

/** Executes a generated tool by re-dispatching its HTTP request to the REST
 * route over loopback, authenticated as `auth`. */
export async function callApiTool(tool: McpOpenAPITool, input: Record<string, unknown>, auth: AuthContext): Promise<CallToolResult> {
  let request;
  try {
    request = buildHttpRequest(tool, input, { baseUrl: LOCAL_ORIGIN });
  } catch (err) {
    return errorResult(`Invalid arguments: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, [INTERNAL_AUTH_HEADER]: issueInternalAuthToken(auth) },
      body: request.body as BodyInit | undefined,
      redirect: 'manual',
    });
    return await toToolResult(res, tool);
  } catch (err) {
    return errorResult(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Registers every tool `auth` may use on `server` (admin-only tools are
 * hidden from regular users; the routes enforce the role regardless). */
export function registerApiTools(server: McpServer, tools: ApiTool[], auth: AuthContext): void {
  const isAdmin = auth.user.role === 'admin';
  for (const { tool, name, config, adminOnly } of tools) {
    if (adminOnly && !isAdmin) continue;
    server.registerTool(name, config, (input) => callApiTool(tool, input as Record<string, unknown>, auth));
  }
}
