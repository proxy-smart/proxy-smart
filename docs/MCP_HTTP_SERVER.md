# MCP HTTP Server

Proxy Smart serves the Model Context Protocol over Streamable HTTP. The transport is the official [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) SDK, wrapped by [`@maxhealth.tech/mcp-http`](https://github.com/Max-Health-Inc/mcp-http) for the OAuth gate, CORS, and observability. Protocol semantics come from the SDK, so this repository does not reimplement them. What that means concretely is set by the SDK version in `backend/package.json`: `@modelcontextprotocol/server` 2.x resolves `@modelcontextprotocol/core`, whose `LATEST_PROTOCOL_VERSION` is **2025-11-25**. That is this deployment's ceiling.

There are two endpoints, and they are different servers:

| Endpoint | Tools | Registered by |
|---|---|---|
| `/mcp` | The backend's own admin API, derived from the Elysia route table | [`backend/src/routes/mcp-endpoint.ts`](https://github.com/proxy-smart/proxy-smart/blob/main/backend/src/routes/mcp-endpoint.ts) |
| `/fhir/{server_id}/mcp` | `fhir_read`, `fhir_search`, `fhir_create`, `fhir_update`, `fhir_delete`, `fhir_capabilities`, bound to one configured FHIR server | [`backend/src/routes/fhir-mcp.ts`](https://github.com/proxy-smart/proxy-smart/blob/main/backend/src/routes/fhir-mcp.ts) |

Both speak JSON-RPC 2.0 over `POST`. Neither accepts the ad-hoc `{"type":"listTools"}` envelope that earlier revisions of this document described; use an MCP client, or `tools/list` and `tools/call` directly.

## Protocol version

The server negotiates down to what the client asks for, and caps at the SDK's latest. Measured
against this repository's own endpoint:

| Client asks for | Server negotiates |
|---|---|
| `2025-03-26` | `2025-03-26` |
| `2025-06-18` | `2025-06-18` |
| `2025-11-25` | `2025-11-25` |
| `2026-07-28` | `2025-11-25` |
| anything unrecognised | `2025-11-25` |

A client asking for a revision newer than the SDK supports is **not** rejected — it is quietly
answered at `2025-11-25`. So pinning `MCP-Protocol-Version: 2026-07-28` appears to work while
delivering none of that revision's additions. Ask for `2025-11-25`, or send no version header and
let the SDK default apply.

Raising the ceiling is an SDK bump, not a change here. `@proxy-smart/elysia-mcp` carries no
protocol version at all — it derives tools and executes them, and the revision is entirely the
SDK's business.

## Statelessness

Both endpoints are stateless. `mcp-http` leaves the SDK's `legacy` mode at `'stateless'`, so a client on an older revision is served one fresh server instance per request rather than being turned away.

This is deliberate. The session store that used to live in `mcp-endpoint.ts` held transports in process memory, so every redeploy silently invalidated every live connection and the next request got `404 Session not found`. On an environment that redeploys many times a day, that was most of them. There is no `Mcp-Session-Id` to send and none to honour.

One consequence worth planning around: because a server is built per request from the caller's token, the tool list a caller sees is filtered by that token's roles, and `listChanged` is advertised as `false` on both `tools` and `resources`. Clients should not expect push notifications about tool changes.

## Authorization

### Discovery

A client that gets a 401 follows the pointer in `WWW-Authenticate` to the protected-resource metadata, and from there to the authorization server.

```
GET /.well-known/oauth-protected-resource
  → resource, authorization_servers[], bearer_methods_supported, scopes_supported

GET /.well-known/oauth-authorization-server
  → authorization_endpoint, token_endpoint, registration_endpoint, jwks_uri, …
```

Both are served by [`backend/src/routes/auth/mcp-metadata.ts`](https://github.com/proxy-smart/proxy-smart/blob/main/backend/src/routes/auth/mcp-metadata.ts). `authorization_servers` points at the proxy's own base URL, not directly at Keycloak, because the proxy owns the `registration_endpoint` and fronts `/auth/authorize` and `/auth/token` to add SMART launch-context enrichment and audience enforcement. The AS metadata sets `issuer` to the proxy base URL for the same reason, and advertises `authorization_response_iss_parameter_supported: true` (RFC 9207) so clients that string-compare `iss` against the document match.

Path-insertion variants are served too, since MCP clients try them first: `/.well-known/oauth-protected-resource/*`, `/.well-known/oauth-authorization-server/auth`, and `/.well-known/openid-configuration/auth`.

`/.well-known/jwks.json` merges Keycloak's realm keys with the proxy's own signing key, so a client validating a token never has to know Keycloak exists.

### The 401 challenge

```
WWW-Authenticate: Bearer resource_metadata="{BASE_URL}/.well-known/oauth-protected-resource", scope="openid profile email"
```

Two details differ from what `mcp-http` emits on its own, and `withChallenge` in `mcp-endpoint.ts` rewrites the header to supply them. The pointer is built from `config.baseUrl` rather than `req.url`, so a spoofed `Host` behind a proxy that does not normalise it cannot aim a client at an attacker's metadata document. And `scope` is added, because a client following the challenge needs to know what to ask for.

The order of checks matters and is not the order `mcp-http` uses:

1. **Master switch** — a disabled endpoint answers 404 before anything else.
2. **Origin** — a disallowed `Origin` is refused with 403. A DNS-rebound request must be refused outright, not handed a challenge it can act on.
3. **Missing `Authorization`** — 401 with the challenge above, on *any* method. Upstream answers `GET` with 405 and no challenge, which leaves a registering client nothing to follow.
4. **Token validation** — then the SDK handler.

### Scopes

`scopes_supported` is exactly `MCP_SCOPES_SUPPORTED` in [`backend/src/lib/oauth-scopes.ts`](https://github.com/proxy-smart/proxy-smart/blob/main/backend/src/lib/oauth-scopes.ts), which is the standard OIDC default set — `openid profile email`. There is no `read:mcp` or `execute:mcp`; earlier drafts of this document described scopes that were never implemented.

That set is deliberately narrow. Whatever is advertised here is also granted to every client the backend provisions, so anything added must be grantable to any user who can log in. `offline_access` was removed for exactly this reason: it is gated on a realm role, and a user without that role does not get a degraded token — the whole code exchange fails after a successful login. The `authorization_code` grant already returns a session-bound refresh token without it.

`MCP_SCOPE_CHALLENGE` (the `scope` in the 401) is the same list, for the same reason: challenging for an optional scope tells a client to request something it may deliberately not have been granted.

### Audience binding

`/mcp` accepts a token whose `aud` (or `azp`) is one of:

- the MCP endpoint resource itself, per RFC 8707 resource indicators (`getMcpResourceAudience()`)
- the admin web app client (`adminUiClientId`)
- the backend admin service account (`adminClientId`)

A patient-facing SMART app token, whose audience is the FHIR base, is rejected. `adminUiClientId` must be accepted independently of `adminClientId`, because on beta and production the latter is the service account.

Validation is fail-closed on audience. If Keycloak is not configured with the audience mappers, tokens are rejected rather than waved through.

`/fhir/{server_id}/mcp` validates the token but does not pin the audience, because it forwards that same token to the FHIR server as the caller's identity; scope and consent enforcement happen in the shared FHIR proxy path.

### Other MCP servers that sign in through this proxy

An MCP server hosted elsewhere can name this proxy as its authorization server, so MCP clients register here (DCR or CIMD) and users sign in through the realm's identity providers. The client must send `resource=<that server's URL>`, and Keycloak narrows `aud` to exactly that URL.

If the server only checks the token, nothing more is needed. If it must exchange it (RFC 8693), for example to read FHIR as itself, Keycloak only exchanges a token whose `aud` holds the requesting client's id. Register the server as a SMART app whose **client id is its https resource URL** and set `resourceServer: true`:

```json
{ "clientId": "https://scribe.example.com/mcp", "clientType": "backend-service", "tokenExchangeEnabled": true, "resourceServer": true, "jwksString": "…" }
```

The proxy sets `resource_url` to the client id and adds the client to the `resource-indicators` audience set, so a token issued for that URL can be exchanged by it. The exchange records the actor chain as usual, for example `https://scribe.example.com/mcp` acting for the MCP client. `POST /admin/smart-config/reconcile-resource-indicators` repairs the audience set if it drifts.

### Roles

`/mcp` reads realm roles and client roles off the validated token and unions them. A tool or resource whose route is not marked `meta.public` is registered only when the caller holds `admin`. Because registration happens per request, a non-admin never sees the tool in `tools/list` at all — this is a visibility filter, not just a call-time rejection.

## Client registration

An MCP client resolves a `client_id` in this order:

1. **Pre-registered** — the client already has one. `mcp-client` is provisioned as a public client using authorization code + PKCE.
2. **Client ID Metadata Document (CIMD)** — the client sends its `client_id` as a URL and Keycloak fetches the metadata. Requires Keycloak `--features=cimd`.
3. **Dynamic Client Registration (DCR)** — the client calls `registration_endpoint`, which is the proxy's `/auth/register` (RFC 7591), not Keycloak's native one. Keycloak's requires initial access tokens and a trusted-host policy.
4. **Prompt the user** — fallback; enter `mcp-client` when asked.

Both CIMD and DCR are advertised via `client_registration_types_supported`. `token_endpoint_auth_methods_supported` is patched to include `none`, which Keycloak's own OIDC document omits despite supporting public clients — DCR creates public clients with `token_endpoint_auth_method=none`, so without this a client reads the metadata and concludes it cannot authenticate.

### CIMD setup (Keycloak admin console)

1. Start Keycloak with `--features=cimd` (already set in every deployment compose file and the Dockerfile).
2. **Client profile** (`Realm Settings → Client Policies → Profiles`) — add the `client-id-metadata-document` executor, set trusted domains (e.g. `vscode.dev`, `127.0.0.1`), **Restrict same domain** off (VS Code redirects to localhost), **Only Allow Confidential Client** off (VS Code is public).
3. **Client policy** (`Realm Settings → Client Policies → Policies`) — add the `client-id-uri` condition, URI scheme `https`, trusted domains matching step 2, and associate the profile.

### VS Code

`.vscode/mcp.json` for an `http` server accepts `type`, `url`, `headers`, and `dev`. There is no `clientId` field; VS Code runs OAuth itself.

```jsonc
{
  "servers": {
    "proxy-smart": {
      "type": "http",
      "url": "https://your-instance.example.com/mcp"
    }
  }
}
```

## Tools

### Where they come from

Tools on `/mcp` are derived from the Elysia route table by [`@proxy-smart/elysia-mcp`](../packages/elysia-mcp/README.md), which reads path, method, body/query/params schemas, the handler reference, and the route's `meta.public` flag. Only routes under the configured prefixes are considered, so a route is never exposed merely by existing. Naming, resource URIs, and the annotations derived from each HTTP verb are documented in that package; [Backend API Tools](./BACKEND_API_TOOLS.md) summarises them.

Execution goes back through the real Elysia pipeline via a registered dispatch app, so route guards, response-schema coercion, and lifecycle hooks such as admin audit logging all run. There is no fallback: the app is a required argument to the executor, so a route cannot be run outside the pipeline. The `getAdmin` / `getAccessControl` decorators that served the old synthetic path are gone with it — handlers get their decorators from the app.

Three tools are hand-written rather than derived:

- **`search_documentation`** — semantic search over the platform documentation knowledge base.
- **`read_resource`** — a single tool that collapses every read-only `GET` route. It takes a `path` and optional `query` map, and its description enumerates the paths the caller is allowed to read. Registered only when `exposeResourcesAsTools` is on. Collapsing hundreds of `get_*` tools into one keeps the tool list inside what a client will actually load.
- **`show_form`** — draws a write tool's arguments as a form the user fills in, instead of the model guessing them. Registered only when `MCP_PREFAB_UI` is on, since without a host that renders UI there is nothing for it to return.

`GET` routes are additionally registered as MCP **resources** — fixed URIs for static paths, RFC 6570 templates for parameterized ones.

### Response encoding

Tool text is emitted as whichever of JSON and TOON is shorter for that payload (`textFormat: 'auto'`). Admin list endpoints are the high-token responses an agent hits most and are uniform enough for TOON's tabular form to collapse the repeated keys; nested and single-object responses, which TOON handles badly, keep their JSON. `structuredContent` is always JSON.

### Rendered UIs (MCP Apps)

With `MCP_PREFAB_UI=true`, a tool result carries a rendered UI instead of raw JSON in `structuredContent`, and a host that speaks [MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) — VS Code, Claude Desktop, ChatGPT — draws it in a sandboxed iframe. A list becomes a searchable table, a record becomes a detail card. Views are built by [`@maxhealth.tech/prefab`](https://www.npmjs.com/package/@maxhealth.tech/prefab) from the payload alone, so no route writes UI code.

Three things follow from turning it on:

- **The endpoint registers a `ui://` viewer resource.** It is the HTML page the host loads before any tool runs; prefab owns its content, CSP and cache hints, and each tool points at it through `_meta.ui.resourceUri` on its own definition.
- **Tools stop advertising an `outputSchema`.** A result has one `structuredContent` and it cannot mean two things: the spec requires structured results to conform to a declared output schema, and a view does not. This is why the flag defaults to off — the machine-facing contract is unchanged until a deployment asks for UI.
- **Nothing changes for the model.** The payload stays in the text block under the encoding described above, and `structuredContent` never enters model context, so the UI costs no tokens. A payload with no sensible view (a scalar, an empty body) keeps its JSON, and a view that fails to build is dropped rather than failing the call.

It also registers **`show_form`**, which is the input side of the same idea. Given a write tool's name it returns a form built from that tool's own input schema, and submitting the form calls the tool — so what the form asks for and what the call validates come from one declaration and cannot drift. `values` pre-fills fields, which is also how a form is bound to one record (`{ userId: "abc123" }` for `update_admin_users_userId`); path params stay fields, because they are arguments of the call. The model is told what was drawn and that nothing has changed yet, so it does not report the edit as done before the user submits.

### Controlling exposure

Exposure is configured through the admin UI (**AI Tools → MCP Endpoint**) and persisted by [`backend/src/lib/mcp-endpoint-config.ts`](https://github.com/proxy-smart/proxy-smart/blob/main/backend/src/lib/mcp-endpoint-config.ts) — PostgreSQL when `DATABASE_URL` is set, otherwise `DATA_DIR/mcp-endpoint.json`.

| Field | Meaning |
|---|---|
| `enabled` | Master switch. When false, `/mcp` answers 404. |
| `enabledTools` | Allowlist. When non-null it wins outright: only these are exposed. |
| `disabledTools` | Blocklist, used when `enabledTools` is null. |
| `exposeResourcesAsTools` | Whether `read_resource` is registered. |

Three tools are protected and stay exposed regardless of configuration, so you cannot lock yourself out of the endpoint that would let you undo it: `get_admin_mcp-endpoint`, `update_admin_mcp-endpoint`, and `update_admin_mcp-endpoint_tools_toolName`.

Reads are synchronous and come from a short-TTL cache, so a write from one task is observed by every task within seconds.

## Per-server FHIR endpoint

`/fhir/{server_id}/mcp` exposes FHIR operations bound to one configured server. `server_id` is the server's name in the FHIR server store; the tools take no `serverName` parameter.

The endpoint answers 404 if the server is unknown and 403 if its `mcpEnabled` flag is off, both before the protocol handler runs — those are facts about the server, not about the request. Origin and challenge handling then mirror `/mcp`, with the challenge pointing at the path-scoped metadata document (`/.well-known/oauth-protected-resource/fhir/{server_id}/mcp`).

| Tool | Annotations |
|---|---|
| `fhir_read` | read-only, idempotent |
| `fhir_search` | read-only, idempotent |
| `fhir_capabilities` | read-only, idempotent |
| `fhir_create` | — |
| `fhir_update` | idempotent |
| `fhir_delete` | destructive, idempotent |

Every call inherits auth, consent, scope enforcement, and capability-aware normalization from the shared FHIR proxy, so the caller's SMART scopes decide what actually succeeds: `patient/*.read` or `user/*.read` for the read tools, `*.write` for create and update.

`fhirVersion` is optional on every tool and defaults to the server's primary version.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `MCP_ENDPOINT_PATH` | Path the endpoint is mounted at | `/mcp` |
| `MCP_PREFAB_UI` | Render tool results as prefab UIs for MCP Apps hosts | `false` |
| `DATA_DIR` | Where `mcp-endpoint.json` lives when `DATABASE_URL` is unset | — |
| `DATABASE_URL` | When set, endpoint config is stored in PostgreSQL instead | — |

Whether the endpoint is enabled is **not** an environment variable — the file- or database-backed config is the single source of truth, so it can be toggled from the admin UI without a redeploy.

Everything else the endpoint needs comes from the existing Keycloak and base-URL configuration: `BASE_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, and the admin client settings. See [Environment Variables](./environment-variables.md).

## Manual testing

```bash
TOKEN=...   # an access token whose aud matches the MCP resource

# Discovery, unauthenticated
curl -i https://example.com/mcp                      # 401 + WWW-Authenticate
curl https://example.com/.well-known/oauth-protected-resource

# List tools
curl -X POST https://example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call one
curl -X POST https://example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"read_resource","arguments":{"path":"/admin/healthcare-users"}}}'
```

Automated coverage lives in `backend/test/mcp-endpoint.test.ts` and `backend/test/fhir-mcp-tools.test.ts`.

```bash
bun run test:backend
```

## Troubleshooting

**401 on every call, token looks valid.** The `aud` claim does not match. `/mcp` requires the MCP resource audience, `adminUiClientId`, or `adminClientId`. A SMART app token aimed at the FHIR base will not work here. Validation is fail-closed, so a missing Keycloak audience mapper looks identical to a forged token.

**`invalid_target` from Keycloak.** The realm is missing the resource-indicator scope, or the client was created outside the proxy. Every client the backend provisions gets it automatically.

**A tool is missing from `tools/list`.** Either the caller is not `admin` and the route is not `meta.public`, or the tool is filtered by `enabledTools` / `disabledTools`. Both are per-request, so re-listing with a different token gives a different answer.

**`404 Session not found`.** From a client pinning `Mcp-Session-Id`. The endpoint is stateless; drop the header.

**Client cannot register.** Check that `/auth/register` is reachable and that the AS metadata advertises it. If DCR fails, VS Code falls back to prompting — enter `mcp-client`.

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [`@maxhealth.tech/mcp-http`](https://github.com/Max-Health-Inc/mcp-http) — the HTTP edge, shared across the organization
- [`@proxy-smart/elysia-mcp`](../packages/elysia-mcp/README.md) — route table to tools
- [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected resource metadata · [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) AS metadata · [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707) resource indicators · [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) DCR · [RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) issuer identification
- [Keycloak as an MCP authorization server](https://www.keycloak.org/securing-apps/mcp-authz-server)
