// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/elysia-mcp
 *
 * Derives MCP tools and resources from an Elysia app's route table, and executes
 * them back through that app. The HTTP edge is not here: hosts serve MCP with
 * @maxhealth.tech/mcp-http, which tracks the protocol through the SDK.
 *
 * @example
 * ```ts
 * const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
 * const meta = tools.get('create_admin_users')
 * await executeTool('create_admin_users', meta, args, token, decorators)
 * ```
 */

// ── Re-exports ───────────────────────────────────────────────────────────────

export type { ToolMetadata, ToolAnnotations, ResourceMetadata } from './types'

export {
  extractRouteTools,
  extractRouteResources,
  extractResponseSchema,
  annotationsForMethod,
  pathToToolName,
  uniqueToolName,
  describeTool,
  MAX_TOOL_NAME_LENGTH,
  pathToResourceName,
  pathToResourceUri,
} from './introspect'

export type { IntrospectOptions } from './introspect'

export {
  typeboxToSchema,
  typeboxToOutputSchema,
  typeboxToJsonSchema,
  getMergedInputSchema,
} from './typebox-schema'

export {
  executeTool,
  executeResource,
  executeResourceResult,
  applyView,
  type ExecuteOptions,
  type ResourceResult,
  type StructuredContent,
  type ToolView,
  type ToolViewContext,
} from './executor'

export { chooseToolText, type ToolTextFormat } from './text-format'

export { MCP_REQUEST_HEADERS, MCP_EXPOSED_RESPONSE_HEADERS } from './headers'
