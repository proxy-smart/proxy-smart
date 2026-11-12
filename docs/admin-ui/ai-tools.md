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

Tools are listed grouped by category, derived from the tool name — `create_admin_smart-apps_` sits under SMART Apps, and so on. Each row has a toggle that writes through to `PUT /admin/mcp-endpoint/tools/:toolName`.

Which list the toggle writes to depends on the mode. With an allowlist set (`enabledTools` non-null), only listed tools are exposed and the toggle adds or removes from it. Otherwise the endpoint is in blocklist mode and the toggle maintains `disabledTools`.

These ignore the toggle and stay exposed, so the endpoint that would let you undo a change is always reachable:

<!-- generated:protected-tools -->
| Route | Tool |
|---|---|
| `GET /admin/mcp-endpoint/` | `get_admin_mcp-endpoint_` |
| `PATCH /admin/mcp-endpoint/` | `update_admin_mcp-endpoint_` |
| `PUT /admin/mcp-endpoint/tools/:toolName` | `update_admin_mcp-endpoint_tools_toolName` |
<!-- /generated:protected-tools -->

The list also includes two tools that are not derived from routes: `search_documentation` (semantic search over the platform docs) and `read_resource` (the collapsed read path, present when **Expose resources as tools** is on).

Read-only tools are flagged as such. Note that the visible list is the full admin catalog; what a given MCP client actually sees is filtered again at request time by the roles on its token.

## Exposed resources

`GET` routes are also published as MCP resources — a fixed URI for a static path, an RFC 6570 template for a parameterized one. The same allowlist and blocklist govern them.

## API endpoints

<!-- generated:admin-routes /admin/mcp-endpoint -->
| Method | Path | Summary |
|---|---|---|
| `GET` | `/admin/mcp-endpoint/` | Get MCP endpoint status |
| `PATCH` | `/admin/mcp-endpoint/` | Update MCP endpoint configuration |
| `PUT` | `/admin/mcp-endpoint/tools/:toolName` | Toggle a single MCP tool |
<!-- /generated:admin-routes -->

## Environment variables

<!-- guido:fields #mcp -->
| Variable | Description | Default |
|---|---|---|
| `MCP_ENDPOINT_PATH` | Path under BASE_URL where the Streamable HTTP MCP endpoint is mounted; it is also the MCP resource indicator and an accepted token audience. Must start with a slash. | `/mcp` |
| `MCP_PREFAB_UI` | Render MCP tool results as prefab UIs for MCP Apps hosts such as VS Code or Claude Desktop. When on, tools stop advertising an outputSchema; only the exact value true enables it. | `false` |
| `OPENAI_API_KEY` | OpenAI API key used to embed the documentation for the semantic documentation search tool. Without it documentation search is disabled and the rest of the backend runs normally. | *secret* |
| `OPENAI_EMBEDDING_MODEL` | OpenAI embedding model used to index the documentation for semantic search (the docs API and the search_documentation MCP tool). Changing it rebuilds the embedding cache. | `text-embedding-3-small` |
| `RAG_CHUNK_SIZE` | Target size in characters of each documentation chunk embedded for semantic search. Larger chunks give more context per hit and fewer embeddings. | `1200` |
| `RAG_DOCS_DIR` | Directory of markdown documentation that semantic documentation search indexes. Set it only when the docs live somewhere the automatic lookup does not find. When unset: The first existing docs directory next to the backend: the repository docs/ in development, /app/docs in the Docker image. | -- |
| `RAG_EMBEDDING_BATCH_SIZE` | How many documentation chunks are sent to the OpenAI embeddings API per request when building the search index. Lower it if requests hit rate or size limits. | `64` |
| `RAG_MIN_CHUNK_SIZE` | Smallest documentation chunk in characters kept on its own for semantic search; shorter fragments are merged with neighbours. | `200` |
<!-- /guido:fields -->

## See also

[MCP HTTP Server](../MCP_HTTP_SERVER) covers the transport, OAuth discovery, audience rules, and the deprecated per-server FHIR endpoint at `/fhir/{server_id}/mcp`.
