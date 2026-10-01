// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/elysia-mcp - Tool & Resource Execution
 *
 * Execution dispatches the tool/resource through the app's own HTTP pipeline:
 * a `Request` is reconstructed from the route metadata + args + token and handed
 * to `app.handle()`. That runs the FULL Elysia lifecycle — `beforeHandle` guards,
 * response-schema coercion, and `onAfterResponse` hooks such as audit logging.
 * Pass the ROOT app so global plugins and route prefixes resolve.
 *
 * There is deliberately NO synthetic-context fallback. Calling the handler
 * directly is what commit 3bc8d07ac was fixing: it skipped guards, response
 * schemas and audit logging, and it stayed reachable afterwards because the app
 * arrived through an OPTIONAL bag of decorators, so forgetting it silently
 * selected the unguarded path. The app is a required argument now, which is why
 * that class of mistake no longer type-checks.
 */

import { Value } from '@sinclair/typebox/value'
import type { ToolMetadata, ResourceMetadata } from './types'
import { getMergedInputSchema } from './typebox-schema'
import { pathToToolName } from './introspect'
import { chooseToolText, type ToolTextFormat } from './text-format'

/** Per-call execution options. */
export interface ExecuteOptions {
  /**
   * Encoding for the text block a client feeds to the model. Defaults to
   * `json`, so this is opt-in and no existing caller changes behaviour.
   * See {@link chooseToolText}.
   */
  textFormat?: ToolTextFormat
  /**
   * Renders the payload as a UI the host displays instead of the raw JSON.
   * See {@link ToolView}.
   */
  view?: ToolView
}

/** What a {@link ToolView} is told about the call it is rendering. */
export interface ToolViewContext {
  /** Registered MCP tool name (e.g. `list_admin_roles`). */
  toolName: string
  /** The route the tool was derived from. */
  meta: ToolMetadata
}

/**
 * Turns a tool's payload into the wire object a UI host renders.
 *
 * The result replaces the payload as `structuredContent`, which is where MCP
 * Apps hosts look: the host forwards the whole `CallToolResult` into the
 * sandboxed iframe, and the renderer reads the view from there. The text block
 * is left alone and still carries the payload, so the model reads the data and
 * pays nothing for the UI — `structuredContent` never enters model context.
 *
 * A tool whose payload is replaced this way must NOT advertise an
 * `outputSchema` derived from its route response: the spec requires structured
 * results to conform to the schema the tool declares, and a view does not.
 *
 * Return undefined for anything this view does not want to render; the payload
 * is then passed through untouched.
 *
 * @see `@proxy-smart/elysia-mcp/prefab` for a ready-made implementation.
 */
export type ToolView = (
  payload: StructuredContent,
  context: ToolViewContext,
) => StructuredContent | undefined

/** Minimal shape of an Elysia app we depend on for pipeline dispatch. */
interface DispatchableApp {
  handle(request: Request): Promise<Response> | Response
}

// ── Tool Execution ───────────────────────────────────────────────────────────

/**
 * Execute a tool (route handler) with the given arguments.
 *
 * Dispatches through the real Elysia pipeline when a `__app` decorator is
 * present; otherwise falls back to the synthetic-context invocation.
 */
export async function executeTool(
  toolName: string,
  meta: ToolMetadata,
  args: Record<string, unknown>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: StructuredContent
  isError?: boolean
}> {
  try {
    // Validate args against merged schema
    const inputSchema = getMergedInputSchema(meta)
    if (inputSchema) {
      const valid = Value.Check(inputSchema, args)
      if (!valid) {
        const errors = [...Value.Errors(inputSchema, args)]
        return {
          content: [{ type: 'text', text: `Validation error: ${JSON.stringify(errors)}` }],
          isError: true,
        }
      }
    }

    const { status, text } = await dispatchThroughPipeline(app, meta.path, meta.method, args, authToken)
    if (status >= 400) {
      return { content: [{ type: 'text', text }], isError: true }
    }
    return successResult(text, options, { toolName, meta })
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}

// ── Resource Execution ───────────────────────────────────────────────────────

/** A resource read: the text a client receives, plus a view when one rendered. */
export interface ResourceResult {
  /** The payload, under whichever encoding `textFormat` chose. */
  text: string
  /** The rendered view, when a `view` was supplied and produced one. */
  structuredContent?: StructuredContent
}

/**
 * Execute a GET route handler and return the serialized result.
 *
 * Dispatches through the real Elysia pipeline when a `__app` decorator is
 * present; otherwise falls back to the synthetic-context invocation.
 */
export async function executeResource(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<string> {
  const { text } = await executeResourceResult(meta, pathParams, authToken, app, options)
  return text
}

/**
 * The same read, with the view alongside the text.
 *
 * A resource read answers with a string, which is all `resources/read` can
 * carry — but a TOOL that stands in for many resources returns a full tool
 * result and can carry a view too. It has to be rendered from the payload
 * BEFORE the text encoding is chosen: under `textFormat: 'auto'` the text may
 * be TOON, and a view built by parsing that would silently never render on
 * exactly the large uniform lists TOON is chosen for.
 */
export async function executeResourceResult(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<ResourceResult> {
  const serialized = await readResource(meta, pathParams, authToken, app)
  const view = applyView(serialized, options?.view, {
    toolName: pathToToolName(meta.path, 'GET'),
    meta,
  })
  const text = chooseToolText(serialized, options?.textFormat)
  return view !== undefined ? { text, structuredContent: view } : { text }
}

/** Run the route and serialize whatever it answered, as JSON, without encoding choices. */
async function readResource(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
): Promise<string> {
  try {
    // pathParams are pre-resolved by the caller; feed them as args so the
    // shared URL builder interpolates them into the concrete path.
    const { text } = await dispatchThroughPipeline(app, meta.path, 'GET', pathParams, authToken)
    return text
  } catch (err) {
    return JSON.stringify({ error: `Resource read failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}

// ── Pipeline dispatch ──────────────────────────────────────────────────────────

/**
 * Reconstruct an HTTP Request from route metadata + args + token and dispatch it
 * through the real Elysia pipeline, returning the parsed status + body text.
 *
 * - Path params (`:name` segments) are interpolated into the URL.
 * - For GET, remaining args become query-string params.
 * - For mutations, remaining args become the JSON body.
 */
async function dispatchThroughPipeline(
  app: DispatchableApp,
  path: string,
  method: string,
  args: Record<string, unknown>,
  authToken?: string,
): Promise<{ status: number; text: string }> {
  const { url, rest } = buildUrl(path, method, args)
  const isGet = method.toUpperCase() === 'GET'

  const headers = bearerHeaders(authToken)
  const init: RequestInit = { method, headers }
  if (!isGet && Object.keys(rest).length > 0) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(rest)
  }

  const response = await app.handle(new Request(`http://localhost${url}`, init))
  const text = await response.text()
  return { status: response.status, text }
}

/**
 * Build the concrete request URL by interpolating path params and (for GET)
 * appending remaining args as query parameters. Returns the URL plus the args
 * that were NOT consumed as path params (the request body / query payload).
 */
function buildUrl(
  path: string,
  method: string,
  args: Record<string, unknown>,
): { url: string; rest: Record<string, unknown> } {
  const pathParams = extractPathParams(path, args)
  let url = path
  for (const [name, value] of Object.entries(pathParams)) {
    url = url.replace(`:${name}`, encodeURIComponent(value))
  }

  const rest = { ...args }
  for (const key of Object.keys(pathParams)) delete rest[key]

  if (method.toUpperCase() === 'GET' && Object.keys(rest).length > 0) {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) qs.append(key, String(value))
    }
    const query = qs.toString()
    if (query) url += `?${query}`
    return { url, rest: {} }
  }

  return { url, rest }
}


/**
 * Build a successful tool result. Always includes a text content block, which
 * the spec asks for alongside structured content for backwards compatibility,
 * and which also opts out of the SDK's SEP-2106 §4.3 auto-append. When the
 * payload parses as JSON it is ALSO attached as `structuredContent`.
 *
 * Arrays are included. They used to be dropped because the 2025 wire shape
 * requires `structuredContent` to be an object, but reconciling that is the
 * SDK's job, not this function's: `projectCallToolResult` wraps a non-object
 * value as `{result:…}` for a 2025-era client and passes it through on 2026.
 * Dropping them here instead discarded the structured half of exactly the list
 * responses that carry the most data — and, once a route's response schema is
 * advertised as the tool's `outputSchema`, omitting it would leave the result
 * not conforming to the schema the tool advertises.
 *
 * `structuredContent` is derived from the ORIGINAL serialized JSON, never from
 * the text block: under `textFormat: 'auto'` the two can be different encodings
 * of the same data, and the structured half is required by the spec to be JSON.
 */
function successResult(
  text: string,
  options: ExecuteOptions | undefined,
  context: ToolViewContext,
): {
  content: { type: 'text'; text: string }[]
  structuredContent?: StructuredContent
} {
  const structured = toStructuredContent(text)
  // A 204 or an otherwise bodyless success leaves nothing to render, and clients
  // reject an empty content[].text block outright rather than reading it as "no
  // data". Say so instead of emitting nothing.
  const chosen = chooseToolText(text, options?.textFormat)
  const rendered = chosen.trim() === '' ? '(no content)' : chosen
  const content = [{ type: 'text' as const, text: rendered }]

  const view = applyView(text, options?.view, context)
  if (view !== undefined) return { content, structuredContent: view }

  return structured !== undefined
    ? { content, structuredContent: structured }
    : { content }
}

/**
 * Render a serialized payload through a view, or give up on it.
 *
 * A view is presentation: a builder that throws on an unexpected payload must
 * not turn a successful call into a failed one, so the caller falls back to the
 * payload it would have sent anyway. Exported because a handler that assembles
 * its own tool result — one tool standing in for many routes, say — needs the
 * same step, and reimplementing the guard is how the guard gets forgotten.
 */
export function applyView(
  serialized: string,
  view: ToolView | undefined,
  context: ToolViewContext,
): StructuredContent | undefined {
  if (view === undefined) return undefined
  const payload = toStructuredContent(serialized)
  if (payload === undefined) return undefined
  try {
    return view(payload, context)
  } catch {
    return undefined
  }
}

/**
 * A JSON value the MCP SDK accepts as `structuredContent`. Objects and arrays
 * only: a bare primitive carries no more than the text block already does, and
 * would just add a `{result:…}` wrap on 2025-era clients for nothing.
 */
export type StructuredContent = Record<string, unknown> | unknown[]

/** Parse text to a JSON object or array for `structuredContent`, or undefined. */
function toStructuredContent(text: string): StructuredContent | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as StructuredContent
    }
  } catch {
    // Not JSON (or not parseable) — text content is the only representation.
  }
  return undefined
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Request `Authorization` header (capitalized, for the WHATWG Request). */
function bearerHeaders(authToken?: string): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {}
}

/**
 * Extract path parameter values from route path pattern and flat args object.
 * e.g. path="/admin/users/:userId", args={userId: "123", name: "foo"} -> {userId: "123"}
 */
function extractPathParams(path: string, args: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  const paramNames = path.match(/:(\w+)/g)
  if (paramNames) {
    for (const param of paramNames) {
      const name = param.slice(1)
      if (args[name] !== undefined) {
        params[name] = String(args[name])
      }
    }
  }
  return params
}

