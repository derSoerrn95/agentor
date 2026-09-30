# MCP Server

Agentor exposes a [Model Context Protocol](https://modelcontextprotocol.io) server at `<public URL>/mcp` (Streamable HTTP). An AI agent connected to it can do everything the authorizing user can do in the dashboard: manage workers and their whole lifecycle, run commands, drive tmux windows and the virtual desktop, move files, manage environments / capabilities / instructions / init scripts, port and domain mappings, apps, account settings, usage — and, for admins, users, logs, settings and image updates.

The design goal is **zero duplication**: MCP tools are *generated from the REST API's OpenAPI spec* and *executed by the REST routes themselves*. A new route documented with `defineRouteMeta` is an MCP tool automatically.

```
MCP client ──OAuth 2.1──► better-auth (@better-auth/mcp: /api/auth/oauth2/*, /.well-known/*)
MCP client ──Bearer JWT─► /mcp  (server/routes/mcp.ts)
                            └─ requireMcpAuth (JWT verify: iss, aud=/mcp, scope=agentor, JWKS over loopback)
                               └─ resolveTokenUser (user exists, not banned, live consent for the client)
                                  └─ createMcpHandler (SDK v2, stateless, 2025 + 2026-07-28 eras)
                                     └─ McpServer per request: tools from OpenAPI, bound to the user
                                        └─ tool call → buildHttpRequest → fetch(http://127.0.0.1:$PORT/api/...)
                                             + x-agentor-internal-auth (single-use capability)
                                           └─ REST route: same validation, ownership checks, side effects
```

## Files

| File | Role |
|------|------|
| `server/routes/mcp.ts` | The endpoint. Canonicalizes the request URL to the public resource URL (Traefik forwards plain http on an internal host; DPoP proofs / token audience use the public URL) and hands it to the handler. 404 when MCP is disabled. |
| `server/utils/mcp-server.ts` | `useMcpRequestHandler()` — `requireMcpAuth` + `createMcpHandler`; per-request `McpServer` factory with the server `instructions` and the `agentor://guide` resource; token → user resolution. |
| `server/utils/mcp-tools.ts` | OpenAPI → MCP bridge: loads `/api/docs/openapi.json` in-process, generates tools with `mcp-from-openapi`, registers them per user, executes calls over loopback HTTP, maps responses to MCP content. |
| `server/utils/internal-auth.ts` | Single-use, 60 s internal auth capabilities (`x-agentor-internal-auth`) that the `/api` auth middleware redeems for the MCP caller's `AuthContext`. |
| `server/utils/oauth-apps.ts` | Authorized applications per user (better-auth `oauthConsent`), revocation (consent + refresh/access tokens), the consent gate used by the MCP endpoint. |
| `server/routes/.well-known/[...path].ts` | Forwards root-level OAuth discovery (`oauth-protected-resource[/mcp]`, `oauth-authorization-server/api/auth`) to `auth.handler`. |
| `server/mcp/instructions.md` | The agent-facing guide (what Agentor is, concepts, workflows, rules). Sent as MCP `instructions` and served as the `agentor://guide` resource. Loaded as the `mcp` server asset. |
| `app/pages/oauth/consent.vue` | Consent screen (client name, redirect origin, scopes, Approve / Deny). |
| `app/pages/login.vue` | Resumes an OAuth authorization after sign-in (signed `sig` query → `{ redirect, url }`). |
| `app/components/McpAccessSection.vue` | Account modal: MCP URL + setup command, authorized applications with Revoke. |

## Authentication (OAuth 2.1)

better-auth is the authorization server; the only OAuth logic Agentor adds is one registration hook (below).

- **Plugins** (`server/utils/auth.ts`, only when `resolveMcpConfig()` enables MCP):
  - `jwt()` — signs access tokens and serves `/api/auth/jwks`. Its session→JWT `/token` endpoint is disabled (`disabledPaths`) so tokens only come from `/oauth2/token`.
  - `mcp()` from `@better-auth/mcp` — the OAuth 2.1 provider with MCP defaults: authorization code + PKCE (S256), refresh tokens (`offline_access`), consent, RFC 8414 AS metadata, RFC 9728 protected-resource metadata, tokens audience-bound to the resource `<public URL>/mcp`. `loginPage: /login`, `consentPage: /oauth/consent`.
  - Dynamic Client Registration (`allowDynamicClientRegistration` + `allowUnauthenticatedClientRegistration`) — how most MCP clients onboard today. Clients registering with `token_endpoint_auth_method: none` (what MCP clients do) are public and use PKCE; clients omitting it get a client secret. A `hooks.before` on `/oauth2/register` classifies clients whose redirect URIs are all `http` loopback URIs as `application_type: native` (RFC 8252) when they don't say — OIDC registration would default them to `web`, which forbids loopback redirects and rejects most MCP clients.
  - `cimd()` from `@better-auth/cimd` — Client ID Metadata Documents (MCP 2026-07-28 profile), fetched through the SSRF-hardened `@better-auth/cimd/node` transport.
- **Scopes**: `openid profile email offline_access agentor`. `agentor` is the single resource scope = full access as the user (the same rights as in the dashboard; admin-only routes still require the admin role). `requireMcpAuth` enforces it (`MCP_REQUIRED_SCOPES`) and advertises it in challenges; the PRM lists it in `scopes_supported`. Future finer-grained scopes (e.g. read-only) can be added to `OAUTH_SCOPES` and mapped onto tool annotations.
- **Public URL**: the OAuth issuer is `<publicBaseUrl>/api/auth` and the resource `<publicBaseUrl>/mcp`, where `config.publicBaseUrl` is resolved in `config.ts` (see `BETTER_AUTH_URL` in `.env.example`). MCP requires the resource to be HTTPS except on loopback hosts, so an http dashboard domain disables MCP (reason shown in System Settings → Authentication → MCP Server) instead of failing auth init. `MCP_ENABLED` (`.env.example`) turns it off entirely.
- **Flow**: client → `POST /mcp` → 401 `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"` → PRM → AS metadata → register (DCR/CIMD) → browser to `/api/auth/oauth2/authorize` → not signed in: `/login?<signed query>` → sign-in continues the authorization (the `oauthProviderClient` client plugin forwards the signed query; better-auth answers `{ redirect, url }`) → `/oauth/consent` → Approve → client redirect URI with `code` → `/api/auth/oauth2/token` → `Authorization: Bearer <jwt>` on `/mcp`.
- **Verification**: `requireMcpAuth` checks signature, issuer, audience, expiry, scope and DPoP binding. The JWKS is fetched over loopback (`http://127.0.0.1:$PORT/api/auth/jwks`) so verification never depends on the public URL being routable from inside the container.
- **Per-request re-check** (`resolveTokenUser`): access tokens are stateless JWTs (1 h), so every MCP request re-reads the user (deleted / banned → 401) and requires a live consent for the token's client. Revoking an application (Account → MCP access, or `DELETE /api/account/oauth-apps/:clientId`) deletes the consent and the client's refresh / access tokens and takes effect immediately.

## Tool generation

`loadApiTools()` fetches the OpenAPI document Nitro builds from all `defineRouteMeta` blocks (`/api/docs/openapi.json`, in-process) and converts it with **`mcp-from-openapi`**:

- **Inclusion**: every `/api/**` operation with an `operationId`, except tags `Worker Self` (source-IP authenticated, worker-internal), `Setup` (first run), `Health` and `Internal` (browser proxy / WebSocket routes), and operations marked `'x-mcp': false`.
- **Names**: `snake_case(operationId)` — `createContainer` → `create_container`. An `'x-mcp': { name }` override is honoured.
- **Descriptions**: summary + description (`descriptionStrategy: 'combined'`) plus a `Returns: …` line summarizing the response schema. Write route descriptions for an agent reader: what it does, when to use it, what the fields mean.
- **Input schema**: path, query and JSON body parameters merged into one object schema (`$ref`s inlined, `target: 'strict'`); name conflicts are resolved by the library's mapper. When a route accepts several body types, JSON is used (e.g. workspace upload accepts JSON besides multipart for this reason).
- **Annotations**: inferred from the HTTP method (GET → read-only/idempotent, DELETE/PUT → destructive/idempotent, POST/PATCH → destructive), overridable via `'x-mcp': { annotations }`.
- **No `outputSchema`**: route response schemas are documentation; advertising them would oblige every result to carry conforming `structuredContent`.
- **Per-user tool list**: operations marked `'x-admin-only': true` are hidden from non-admins (the route must still call `requireAdmin` — the flag only declutters the tool list).

The generated set is cached per process (the spec is static per build; a dev-server restart regenerates it).

## Tool execution

`callApiTool()` builds the HTTP request with `mcp-from-openapi`'s `buildHttpRequest()` and sends it to the orchestrator's own listener over loopback (`LOCAL_ORIGIN`, `http://127.0.0.1:$PORT`), carrying a freshly minted **internal auth capability** (`issueInternalAuthToken(auth)` → `x-agentor-internal-auth`). The global `/api` auth middleware (`resolveAuthFromEvent`) redeems it once and sets `event.context.auth` to the MCP caller's `AuthContext` (`session` is absent for MCP callers). Everything else — validation, ownership checks (`requireContainerAccess`, …), logging, side effects — is the route's own code.

The client's OAuth token is deliberately **not** forwarded: it is bound to the `/mcp` resource (and possibly DPoP-bound to the `/mcp` URL), and the REST API only accepts browser sessions or internal capabilities.

**Response mapping**: non-2xx → `isError` with `HTTP <status>: <statusMessage>`; JSON → pretty-printed text; `text/*` / PEM → text; `image/*` → image content (desktop screenshot); any other binary → embedded blob resource (e.g. `download_workspace`'s `.tar.gz`). Bodies are read as a stream and abandoned beyond 16 MiB (the route stops streaming when the loopback connection closes), so an oversized download fails fast without being buffered.

## Routes that exist for MCP parity

Dashboard interactions that used to be WebSocket- or browser-only now have request/response REST routes (and therefore tools):

| Route | Tool | What a human does instead |
|-------|------|---------------------------|
| `POST /api/containers/:id/exec` | `exec_command` | types a command in the terminal |
| `POST /api/containers/:id/panes/:windowIndex/keys` | `send_tmux_keys` | types into a terminal tab |
| `GET /api/containers/:id/panes/:windowIndex/capture` | `capture_tmux_window` | reads a terminal tab |
| `GET /api/containers/:id/desktop/screenshot` | `get_desktop_screenshot` | looks at the Desktop pane (worker `maim`) |
| `POST /api/containers/:id/desktop/input` | `send_desktop_input` | clicks / types in the Desktop pane (worker `xdotool`) |
| `POST /api/containers/:id/workspace` (JSON body) | `upload_to_workspace` | drops files on the upload modal |
| `GET /api/containers/:id/workspace?path=` | `download_workspace` | downloads the workspace |
| `/api/users`, `/api/users/:id`, `/api/users/:id/password` | `list_users`, `create_user`, `update_user`, `set_user_password`, `delete_user` | Users modal (which now uses these routes too) |
| `GET /api/account/me`, `PATCH /api/account/profile` | `get_current_user`, `update_account_profile` | Account modal profile |
| `GET /api/account/oauth-apps`, `DELETE /api/account/oauth-apps/:clientId` | `list_authorized_apps`, `revoke_authorized_app` | Account modal → MCP access |

Deliberately **not** exposed (`'x-mcp': false`): `setOwnPassword` / `removeOwnPassword` (credential management stays with the human — lockout risk) and worker `export` / `import` (multi-GB binary bundles do not fit through MCP).

## Extending

- **New feature** → add the REST route with a complete `defineRouteMeta` (`operationId`, `summary`, agent-readable `description`, parameters, request body schema). It becomes an MCP tool on the next start — nothing else to do.
- **Hide** a route from MCP: `'x-mcp': false` (add a comment why).
- **Admin-only** route: call `requireAdmin(event)` and add `'x-admin-only': true`.
- **Rename / re-describe** a tool without touching the REST docs: `'x-mcp': { name, description, annotations }`.
- **Binary results**: return `image/*` for images the agent should see; other binaries become blob resources — prefer JSON/text when an agent needs to read the content.
- **Agent guidance** that spans several tools (workflows, gotchas) belongs in `server/mcp/instructions.md`; keep tool names there in sync (the test suite checks the referenced tools exist).
- **Finer-grained access** (future): add scopes to `OAUTH_SCOPES`, then filter / challenge per tool in `registerApiTools` (the SDK supports per-tool `scopeChallenge`).

## Testing

`tests/helpers/mcp.ts` drives the real protocol: `connectMcp(session)` runs the MCP SDK client's own OAuth machinery (discovery, DCR, PKCE, token exchange) with a signed-in request context playing the user on the consent screen; `obtainTokens()` / `authorizationRequest()` / `requestTokens()` drive individual OAuth steps. Specs: `api/mcp-oauth.spec.ts` (authorization server + resource server behaviour), `api/mcp-tools.spec.ts` (catalog, schemas, annotations, admin filtering, instructions), `api/mcp-platform.spec.ts` (end-to-end platform control through MCP), `ui/mcp-oauth.spec.ts` (consent page, login continuation, account modal revoke).
