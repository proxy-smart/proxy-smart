# @proxy-smart/elysia-mcp

Derives MCP tools and resources from an Elysia app's route table, and executes them back through that app.

An admin API that already exists as typed Elysia routes is, structurally, already a tool catalog: each route has a name, an input schema, and a handler. This package reads that route table rather than asking you to declare the same thing twice. Routes stay the single source of truth, and a route added tomorrow is a tool tomorrow.

The HTTP edge is deliberately not here. Hosts serve MCP with `@maxhealth.tech/mcp-http`, which tracks the protocol through the SDK; this package only bridges Elysia to it.

## What this is not

There are community Elysia MCP plugins on npm — `elysia-mcp` and `elysiajs-mcp` — and they solve the
opposite half of the problem. They give you Streamable HTTP, sessions and resumability, and you hand
them a tool catalog you wrote by hand (`setupServer(server)`, registering each tool). They have no
notion of your route table.

This package has no transport, no sessions and no plugin. It reads the routes you already have and
produces the catalog. The two are stackable rather than competing: the output of `extractRouteTools`
is what such a plugin's `setupServer` would otherwise be written out by hand.

## SDK and protocol version

Requires the **v2** SDK — `@modelcontextprotocol/server` `>=2.0.0`, the split packaging that replaced
the monolithic `@modelcontextprotocol/sdk`. That is a peer dependency, so the host chooses the exact
version.

This package carries **no protocol version**. Nothing here pins, asserts or negotiates a revision;
`extractRouteTools` and `executeTool` produce SDK-shaped values and the SDK decides what goes on the
wire. The revision in force comes from `@modelcontextprotocol/core`, whose `LATEST_PROTOCOL_VERSION`
is `2025-11-25` at v2.0.0, and negotiation happens at the HTTP edge in `mcp-http`. Supporting a newer
revision is an SDK bump, not a change here.

What it does implement of the v2 tool contract is `inputSchema` and `outputSchema` as Standard Schema
(see [Schema conversion](#schema-conversion)) and `structuredContent` on results (see
[Types](#types)).

## Install

Inside this repository it is a workspace package:

```jsonc
// backend/package.json
"@proxy-smart/elysia-mcp": "workspace:*"
```

It is published to GitHub Packages rather than public npm, so an external consumer needs the registry
configured for the `@max-health-inc` scope:

```bash
bun add @proxy-smart/elysia-mcp
```

```ts
import { extractRouteTools, executeTool } from '@proxy-smart/elysia-mcp'

const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
const meta = tools.get('create_admin_users')
await executeTool('create_admin_users', meta, args, token, decorators)
```

Subpath entries expose the pieces individually: `./introspect`, `./typebox-schema`, `./text-format`.

## Introspection

`extractRouteTools(app, options?)` returns a `Map<string, ToolMetadata>` keyed by generated tool name. It reads Elysia's internal `routes` array, pulling path, method, body/query/params schemas, the handler reference, and the route's `meta.public` flag. `HEAD` and `OPTIONS` are skipped; `GET` routes are marked `readOnly` and take their input schema from `query` rather than `body`.

`extractRouteResources(app, options?)` returns a `Map<string, ResourceMetadata>` covering `GET` routes only. Static paths become fixed-URI resources and parameterized paths become URI templates, with the parameter names collected into `pathParams`.

`IntrospectOptions` controls both. `prefixes` limits which routes are considered and defaults to `['/admin/', '/api/']`, so nothing is exposed merely by existing. `toolNameGenerator` and `resourceNameGenerator` override the naming functions below.

## Output schemas

A route's declared success response becomes the tool's `responseSchema`, extracted by `extractResponseSchema`. Elysia accepts either a bare schema or a status-keyed map (`{ 200: t.Array(Role), ...CommonErrorResponses }`); only the success entry is taken, because the error entries describe bodies that never reach `structuredContent` — a non-2xx dispatch returns as `isError` text instead. A declaration with no success entry, or only `204`, yields nothing to advertise.

`typeboxToOutputSchema` converts it for registration. Unlike an input schema it permits a non-object root, which matters because list routes declare `t.Array(...)` and those are the largest responses on the surface.

Advertising this is what makes `structuredContent` worth its bytes. Without an output schema the structured half is an untyped copy of the text block and a client has nothing to validate against; with one it is typed and checkable. It is safe to advertise precisely because Elysia coerces the response to the same schema inside the pipeline, so the body a tool call returns already conforms — which the spec requires of any result whose tool declares an output schema.

Against this repo's own admin surface: 169 tools extracted, 164 carry a declared success schema, all 164 convert, and 19 of them are array-rooted.

Both converters drop the `format` hints Elysia attaches to its coercion unions. `t.Integer()` compiles to `anyOf: [{ type: 'string', format: 'integer' }, { type: 'integer' }]` so a query string can carry a number, and Ajv — which the SDK compiles advertised schemas with — logs `unknown format "integer" ignored` for each one. Only `numeric`, `integer`, `boolean` and `ArrayString` are stripped, and only on the string branch; `date` and `date-time` are genuine formats and pass through. Ajv ignores an unknown format anyway, so this removes noise without changing what a schema accepts.

One conversion gap worth knowing: `t.Date()` emits `{ type: 'Date' }`, which is not valid JSON Schema, so a route declaring it converts to nothing and registers without an output schema. No admin route currently does.

## Naming

`pathToToolName(path, method)` prefixes the flattened path with a verb derived from the method: `GET` becomes `get`, `POST` becomes `create`, `PUT` and `PATCH` become `update`, `DELETE` becomes `delete`. Slashes become underscores and `:` is stripped from parameters. Hyphens in a path segment survive.

| Method | Path | Tool name |
|---|---|---|
| `GET` | `/admin/healthcare-users` | `get_admin_healthcare-users` |
| `GET` | `/admin/healthcare-users/:userId` | `get_admin_healthcare-users_userId` |
| `POST` | `/admin/healthcare-users` | `create_admin_healthcare-users` |
| `PUT` | `/admin/smart-apps/:clientId` | `update_admin_smart-apps_clientId` |
| `DELETE` | `/admin/roles/:roleName` | `delete_admin_roles_roleName` |

`MAX_TOOL_NAME_LENGTH` is 64, the cap clients enforce on a tool name. A generated name longer than
that is cut to fit and given a seven-character FNV-1a digest of the full name as a suffix, so two long
paths that agree up to the truncation point still get distinct names. The digest is deliberately not a
crypto hash: it has to produce the same value on every runtime, because a tool name that shifts
between deploys breaks prompts clients have already saved.

`uniqueToolName(candidate, path, method, taken)` resolves the remaining case — two different routes
generating the same name. It returns the candidate untouched when it is free, and otherwise appends a
digest of `METHOD path`, trimming the base so the result still fits the cap. Without it the second
route would silently overwrite the first in the registry.

`describeTool(toolName, meta)` is the fallback description for a generated name: the verb becomes a phrase (`create` reads "Create a new", `delete` reads "Delete an existing") followed by the remaining segments, and the route is marked `(Public)` or `(Admin only)` from `meta.public`.

`pathToResourceName(path)` is different in two ways, because a resource name reads as a noun rather than an action: parameters become `by_<name>` and hyphens become underscores. `/admin/roles/:roleName` yields `admin_roles_by_roleName`.

`pathToResourceUri(path, scheme?)` produces the RFC 6570 URI template, turning `:param` into `{param}`. With scheme `proxy-smart`, `/admin/roles/:roleName` yields `proxy-smart://admin/roles/{roleName}`.

## Annotations

`annotationsForMethod(method)` maps REST semantics onto the MCP `ToolAnnotations` flags:

| Method | readOnly | destructive | idempotent |
|---|---|---|---|
| `GET` | yes | — | yes |
| `DELETE` | no | yes | yes |
| `PUT` | no | no | yes |
| `PATCH` | no | no | no |
| `POST` | no | no | no |

`DELETE` is idempotent as well as destructive, since deleting an already-deleted thing leaves the same state. `openWorldHint` is false for every route: these tools act on the app's own admin surface, a closed domain.

These are advisory hints a client may use to shape its UX, such as confirming before a destructive call. They are not a security boundary, and nothing enforces them.

## Schema conversion

`typeboxToSchema(schema)` converts a TypeBox schema into the Standard Schema the MCP SDK's `registerTool` accepts. TypeBox schemas are already valid JSON Schema carrying extra Symbol metadata, so the conversion is a JSON roundtrip (which strips the symbols) followed by a handoff to `fromJsonSchema`. There is nothing to translate field by field. It returns `undefined` for anything that is not an object type, so a caller registers the tool with no input schema rather than a broken one.

`typeboxToJsonSchema(schema)` stops one step earlier and returns the plain JSON Schema, for consumers that want the schema itself rather than the Standard Schema wrapper — deriving a form from a route's input is what it exists for.

`getMergedInputSchema(meta)` flattens a route's body and path-params schemas into one object, because an MCP client sees a single flat argument object with no notion of where a value rides in the HTTP request. Path params win on key collision and are always required; the merged `required` array is the union of both.

## Execution

`executeTool(toolName, meta, args, authToken, app, options?)` validates `args` against the merged schema and then dispatches the route through `app.handle()`. The call is turned back into an HTTP `Request`, so the full Elysia lifecycle runs: `beforeHandle` guards, response-schema coercion, and `onAfterResponse` hooks such as audit logging. Pass the **root** app so global plugins and route prefixes resolve.

The app is a required argument, and there is no second way to run a route. An earlier version accepted it as one key inside an optional bag of context decorators and fell back to calling the handler directly through a hand-built context — which skipped guards, response schemas and audit logging. Because the safe path was the opt-in one, omitting the app silently selected the unguarded one. Requiring it means that mistake no longer compiles.

Handler context comes from the app itself: `decorate()` what a route needs, as you would for any Elysia route. The executor injects nothing.

`executeResource` follows the same shape for resource reads.

Both accept an optional `ExecuteOptions` as their last argument, carrying `textFormat` and `view`.

`executeResourceResult` is `executeResource` with the view alongside the text, returning a `ResourceResult` — the `text` a client receives plus the `structuredContent` a view produced. A resource read answers with a string, which is all `resources/read` can carry, but a tool standing in for many resources (`read_resource`) returns a full tool result and can carry a view too.

## Views

A generated tool answers with JSON, so a host that can draw a UI has nothing to draw. `ExecuteOptions.view` is a function handed the payload plus the tool name and route it came from; what it returns replaces the payload as `structuredContent`, which is where an [MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) host looks — the host forwards the whole `CallToolResult` into its sandboxed iframe and the renderer reads the view from there.

The text block is untouched and still carries the payload under whichever encoding `textFormat` chose. The model reads the data and pays nothing for the UI, because `structuredContent` never enters model context.

A view is presentation and cannot fail a call: one that throws or returns `undefined` leaves the result byte-identical to what it would have been without a view. Error results never reach it. That is what makes enabling one globally safe — a tool either gains a UI or is left alone.

One thing does have to change per tool: a tool whose `structuredContent` carries a view must **not** advertise an `outputSchema` derived from its route response, because the spec requires structured results to conform to the schema the tool declares.

### The prefab view

`@proxy-smart/elysia-mcp/prefab` is a ready-made implementation built on [`@maxhealth.tech/prefab`](https://www.npmjs.com/package/@maxhealth.tech/prefab), an **optional** peer — importing that subpath is the opt-in, and a server that serves JSON never installs it.

```ts
import { prefabView, uiToolMeta } from '@proxy-smart/elysia-mcp/prefab'
import { registerViewerResource } from '@maxhealth.tech/prefab'

registerViewerResource(server, { themeBridge: 'vscode' })
server.registerTool(name, { description, inputSchema, _meta: uiToolMeta() }, (args) =>
  executeTool(name, meta, args, token, decorators, { view: prefabView() }))
```

`prefabView()` renders a list of records as a searchable table and a single record as a detail card. A list-shaped envelope holding exactly one array (`{ items: [...], total: 42 }`) is unwrapped; one holding two is left as a record, because picking which array is *the* table would be a guess. Anything else — a scalar, an empty body — renders nothing and keeps its JSON. That behaviour is `defaultView(payload, context, options?)`, exported so a custom view can fall back to it explicitly.

`PrefabViewOptions` shapes it: `render` overrides the view for chosen tools and falls through to the default when it declines, `maxRows` caps what is shipped into the iframe, and `onSkipped` reports the payloads that got no view.

Titles come from the tool name, which is the only human-readable label a generated tool has. `titleFromToolName` drops the verb so a view reads as a noun (`list_admin_smart-apps` → *Admin smart apps*); `labelFromToolName` keeps it, which is what a form wants (`create_admin_roles` → *Create admin roles*).

`toolForm(toolName, meta, options?)`, taking `ToolFormOptions`, is the input side: the form a tool's own input schema describes, whose submit action calls that same tool. Path params are kept rather than dropped — they are required arguments of the call, and a form omitting them would submit something the tool rejects — and `values` pre-fills fields, which is how a form is bound to one record. The submit button takes the tool's own verb (`create_*` → *Create*). It returns `undefined` for a tool with no arguments a flat form can ask for.

`uiToolMeta(uri?)` is the `_meta` pointing a host at the renderer resource. It belongs on the tool **definition**: the host resolves the `ui://` resource when it lists tools, before any call is made.

## Text encoding

The `content[].text` block is what a client feeds to the model, and for list endpoints it is the bulk of an agent's context. `chooseToolText(serialized, format)` decides how it is encoded. `ToolTextFormat` is `'json'` (the default, compact JSON, what every existing caller gets) or `'auto'`.

Under `'auto'` the payload is encoded as both JSON and [TOON](https://github.com/toon-format/toon) and the shorter one wins. TOON collapses a uniform array of flat objects into a header plus rows, the way CSV does, which is a large saving on list responses. It cannot do that when objects carry nested maps or arrays, and falls back to an indented form that is *larger* than compact JSON. Measured against this API's own shapes with `gpt-tokenizer`:

| Response | JSON | TOON | |
|---|---|---|---|
| roles list (30, flat) | 894 | 515 | −42% |
| smart scopes (40, flat) | 973 | 700 | −28% |
| healthcare users (nested) | 3433 | 3808 | +11%, worse |
| single object | 78 | 85 | +9%, worse |

Picking by measurement rather than by a shape heuristic matters: a heuristic would have to re-derive the encoder's own rules about when the tabular form engages, and drift from them as the encoder changes. Comparing the two outputs is correct by construction for any shape, so `'auto'` can never produce a larger text block than `'json'` would.

Length is compared in characters, not tokens. A tokenizer in the hot path is a heavy dependency, and TOON's saving is structural — repeated keys and delimiters removed — so the two move together.

`structuredContent` is unaffected and always JSON. The MCP spec requires it to be a JSON object, so machine consumers never see TOON regardless of this setting.

## CORS

Streamable HTTP has a header contract a host's CORS layer has to honour, and getting it wrong fails browser clients at preflight rather than at call time.

`MCP_REQUEST_HEADERS` lists what belongs in `Access-Control-Allow-Headers`: `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Last-Event-ID`. `Mcp-Method` and `Mcp-Name` became required of clients in MCP 2026-07-28 so intermediaries can route without parsing the JSON-RPC body, which means every conformant browser client sends them and any server omitting them fails that client's preflight.

`MCP_EXPOSED_RESPONSE_HEADERS` lists what belongs in `Access-Control-Expose-Headers`, which the allow-list does not grant. It is deliberately short: only `Mcp-Protocol-Version`. `Mcp-Session-Id` was here while the server was stateful and had to be echoed by the client; statelessly there is no session id to emit, so exposing it advertised a header that is never sent.

## Types

`ToolView` renders a payload into the wire object a host displays, and `ToolViewContext` is what it is told about the call: the `toolName` and the route `meta`. `applyView` runs one under the guard described above, for handlers that assemble their own result.

`ToolMetadata` carries a route's `path`, `method`, `handler`, its `schema`, `paramsSchema` and `responseSchema`, and the `public`, `readOnly` and `annotations` flags. `ResourceMetadata` is the `GET`-only equivalent, adding `pathParams`. `ToolAnnotations` is the MCP annotations object described above.

`StructuredContent` is what a successful result attaches: a JSON object or array. Arrays are included deliberately. The 2025 wire shape requires `structuredContent` to be an object, but reconciling that belongs to the SDK — `projectCallToolResult` wraps a non-object value as `{result:…}` for a 2025-era client and passes it through on 2026. Dropping arrays here instead would discard the structured half of the list responses that carry the most data, and would contradict an advertised array-rooted output schema. Primitives are still omitted: they carry nothing the text block does not.

## Related

- [MCP HTTP Server](https://max-health-inc.github.io/proxy-smart/MCP_HTTP_SERVER) documents the transport and client setup.
- [Backend API Tools](https://max-health-inc.github.io/proxy-smart/BACKEND_API_TOOLS) covers how the proxy-smart backend wires this package up.
