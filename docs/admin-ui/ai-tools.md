# AI Tools

The AI Tools page controls the built-in MCP endpoint: whether it is served at all, and which of the backend's tools and resources it exposes to MCP clients.

## Accessing

Navigate to **AI Tools** in the admin sidebar. The page is a single view backed by `GET /admin/mcp-endpoint/`.

## Endpoint status

The top card shows whether the endpoint is enabled and the URL clients connect to, derived from `BASE_URL` and `MCP_ENDPOINT_PATH`.

| Control | Effect |
|---|---|
| **Enabled** | Master switch. When off, `/mcp` answers 404 to every request. |
| **Expose resources as tools** | Registers the unified `read_resource` tool alongside the MCP resources. |

The path is displayed, not editable — it comes from `MCP_ENDPOINT_PATH` and defaults to `/mcp`. Whether the endpoint is enabled is deliberately not an environment variable, so it can be turned off without a redeploy.

Configuration persists to PostgreSQL when `DATABASE_URL` is set, and otherwise to `DATA_DIR/mcp-endpoint.json`. Reads come from a short-TTL cache, so a change made on one instance is picked up by the others within seconds.

## Exposed tools

Tools are listed grouped by category, derived from the tool name — `create_admin_smart-apps` sits under SMART Apps, and so on. Each row has a toggle that writes through to `PUT /admin/mcp-endpoint/tools/:toolName`.

Which list the toggle writes to depends on the mode. With an allowlist set (`enabledTools` non-null), only listed tools are exposed and the toggle adds or removes from it. Otherwise the endpoint is in blocklist mode and the toggle maintains `disabledTools`.

Three tools ignore the toggle and stay exposed, so the endpoint that would let you undo a change is always reachable:

- `get_admin_mcp-endpoint`
- `update_admin_mcp-endpoint`
- `update_admin_mcp-endpoint_tools_toolName`

The list also includes two tools that are not derived from routes: `search_documentation` (semantic search over the platform docs) and `read_resource` (the collapsed read path, present when **Expose resources as tools** is on).

Read-only tools are flagged as such. Note that the visible list is the full admin catalog; what a given MCP client actually sees is filtered again at request time by the roles on its token.

## Exposed resources

`GET` routes are also published as MCP resources — a fixed URI for a static path, an RFC 6570 template for a parameterized one. The same allowlist and blocklist govern them.

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/mcp-endpoint/` | Current configuration, plus the tool and resource lists with their exposure state |
| `PATCH` | `/admin/mcp-endpoint/` | Update `enabled`, `enabledTools`, `disabledTools`, or `exposeResourcesAsTools` |
| `PUT` | `/admin/mcp-endpoint/tools/:toolName` | Toggle one tool with `{ "exposed": boolean }` |

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `MCP_ENDPOINT_PATH` | URL path the MCP endpoint is mounted at | `/mcp` |
| `OPENAI_API_KEY` | Embeddings for `search_documentation` | -- |
| `DATABASE_URL` | When set, configuration is stored in PostgreSQL rather than on disk | -- |

## See also

[MCP HTTP Server](../MCP_HTTP_SERVER) covers the transport, OAuth discovery, audience rules, and the deprecated per-server FHIR endpoint at `/fhir/{server_id}/mcp`.
