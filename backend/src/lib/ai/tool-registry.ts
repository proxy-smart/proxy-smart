// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Tool Registry - Auto-generates OpenAI function definitions from Elysia routes
 *
 * This module wraps @maxhealth.tech/elysia-mcp's route introspection and adds
 * domain-specific orchestration: global singleton, custom tools, OpenAI format,
 * and the tool executor used by the AI assistant chat.
 */

import type { TSchema } from '@sinclair/typebox'
import {
  extractRouteTools,
  extractRouteResources,
  pathToResourceUri,
  getMergedInputSchema,
  executeTool,
  describeTool,
  type ToolMetadata,
  type ResourceMetadata,
} from '@maxhealth.tech/elysia-mcp'
import { getCustomTools } from './custom-tools'
import { isRecord, stringArray } from '../type-guards'
import { logger } from '../logger'

// Re-export types so existing consumers don't need to change their imports
export type { ToolMetadata, ResourceMetadata }

// ── Module-level singletons (initialized once at startup) ────────────────────

let globalTools: Map<string, ToolMetadata> | null = null
let globalResources: Map<string, ResourceMetadata> | null = null

/**
 * Names of tools that are CUSTOM (not auto-generated from Elysia routes).
 * Custom tools use the `(args, ctx)` handler contract and are invoked directly;
 * route-derived tools use the single-`(ctx)` contract and are dispatched through
 * the HTTP pipeline. Populated by `initializeToolRegistry`.
 */
const customToolNames = new Set<string>()

/**
 * ROOT Elysia app that tool/resource execution is dispatched through, so guards,
 * response schemas and audit hooks run. Set once in app-factory.ts.
 */
interface DispatchApp {
  handle(request: Request): Promise<Response> | Response
}
let dispatchApp: DispatchApp | null = null

/**
 * Register the ROOT app used for secure pipeline dispatch.
 * Call once after all routes (and global plugins) are mounted.
 */
export function setDispatchApp(app: DispatchApp): void {
  dispatchApp = app
}

/** The root app; throws if it was never registered, since there is no unguarded fallback. */
export function requireDispatchApp(): DispatchApp {
  if (!dispatchApp) {
    throw new Error('Dispatch app not registered — setDispatchApp() must run before tool execution')
  }
  return dispatchApp
}

/** Get the registered dispatch app, or null if not yet set. */
export function getDispatchApp(): DispatchApp | null {
  return dispatchApp
}

// ── OpenAI Tool Definition types ─────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    strict?: boolean
  }
}

// ── Re-exports from package (preserving existing public API) ─────────────────

export { extractRouteTools, extractRouteResources, getMergedInputSchema }

/** An Elysia route path as an MCP resource URI in the proxy-smart scheme. */
export function proxySmartResourceUri(path: string): string {
  return pathToResourceUri(path, 'proxy-smart')
}

// ── Singleton lifecycle ──────────────────────────────────────────────────────

/**
 * Initialize the global tool registry (call once at startup after all routes are mounted)
 */
export function initializeToolRegistry(app: unknown, options?: { prefixes?: string[] }): void {
  logger.server.info('Initializing tool registry')

  const routeTools = extractRouteTools(app, options)
  logger.server.info('Extracted route tools', { count: routeTools.size })

  const customTools = getCustomTools()
  customToolNames.clear()
  for (const name of customTools.keys()) customToolNames.add(name)
  globalTools = addCustomTools(routeTools, customTools)
  logger.server.info('Added custom tools', { custom: customTools.size, total: globalTools.size })

  logger.server.debug('Available tools', { tools: Array.from(globalTools.keys()) })

  globalResources = extractRouteResources(app, options)
  logger.server.info('Extracted MCP resources from GET routes', { count: globalResources.size })
}

export function getToolRegistry(): Map<string, ToolMetadata> {
  if (!globalTools) {
    throw new Error('Tool registry not initialized. Call initializeToolRegistry() first.')
  }
  return globalTools
}

export function isToolRegistryInitialized(): boolean {
  return globalTools !== null
}

export function getResourceRegistry(): Map<string, ResourceMetadata> {
  if (!globalResources) {
    throw new Error('Resource registry not initialized. Call initializeToolRegistry() first.')
  }
  return globalResources
}

export function isResourceRegistryInitialized(): boolean {
  return globalResources !== null
}

// ── Custom tools ─────────────────────────────────────────────────────────────

export function addCustomTools(
  tools: Map<string, ToolMetadata>,
  customTools: Map<string, ToolMetadata>,
): Map<string, ToolMetadata> {
  const merged = new Map(tools)
  for (const [name, metadata] of customTools.entries()) {
    merged.set(name, metadata)
  }
  return merged
}

// ── OpenAI format helpers ────────────────────────────────────────────────────

function typeboxToOpenAI(schema: TSchema): ToolDefinition['function']['parameters'] {
  const properties: Record<string, unknown> = isRecord(schema.properties) ? schema.properties : {}
  const required = stringArray(schema.required)
  return { type: 'object', properties, ...(required && { required }), additionalProperties: false }
}

/**
 * Generate OpenAI tool definitions from route metadata
 */
export function generateToolDefinitions(
  tools: Map<string, ToolMetadata>,
  userRoles: string[] = [],
): ToolDefinition[] {
  const definitions: ToolDefinition[] = []

  for (const [toolName, metadata] of tools) {
    if (!metadata.public && !userRoles.includes('admin')) continue

    let parameters: ToolDefinition['function']['parameters'] = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }

    const inputSchema = getMergedInputSchema(metadata)
    if (inputSchema) {
      parameters = typeboxToOpenAI(inputSchema)
    }

    definitions.push({
      type: 'function',
      function: {
        name: toolName,
        description: describeTool(toolName, metadata),
        parameters,
        strict: true,
      },
    })
  }

  return definitions
}

// ── Tool executor (used by AI chat assistant) ────────────────────────────────

/** Context supplied to the AI-chat tool executor. */
export interface ToolExecutorContext {
  userId: string
  roles: string[]
  email?: string
  /** Bearer token forwarded to route handlers so Keycloak RBAC applies. */
  token?: string
  /**
   * ROOT Elysia app for secure pipeline dispatch. Defaults to the registry's
   * registered dispatch app (see `setDispatchApp`). Route-derived tools are
   * dispatched through this app so guards, response-schema coercion, and the
   * audit middleware all run.
   */
  app?: DispatchApp
}

/**
 * Create a tool executor for the AI assistant chat.
 *
 * Route-derived tools are dispatched through the real Elysia HTTP pipeline
 * (forwarding the bearer token), so they are authenticated, response-filtered,
 * guarded, and audited exactly like a direct HTTP call. Custom tools (registered
 * via `getCustomTools`) keep their `(args, ctx)` handler contract.
 */
export function createToolExecutor(
  tools: Map<string, ToolMetadata>,
  context: ToolExecutorContext,
) {
  return {
    async execute(toolName: string, args: unknown): Promise<unknown> {
      const tool = tools.get(toolName)

      if (!tool) {
        throw new Error(`Tool not found: ${toolName}`)
      }

      if (!tool.public && !context.roles.includes('admin')) {
        throw new Error(`Permission denied: ${toolName} requires admin role`)
      }

      const handler = tool.handler
      if (typeof handler !== 'function') {
        throw new Error(`Invalid handler for tool ${toolName}`)
      }

      // Custom tools use the (args, ctx) contract and are invoked directly.
      if (customToolNames.has(toolName)) {
        const output: unknown = await handler(args, { user: context })
        return output
      }

      // Route-derived tools run through the real pipeline (auth, response schema, guards, audit);
      // the executor validates args and returns an MCP envelope, unwrapped below.
      const result = await executeTool(
        toolName,
        tool,
        isRecord(args) ? args : {},
        context.token,
        // The caller's app wins, per the ExecutorContext contract; the registry's
        // registered one is the default. requireDispatchApp throws when neither
        // exists, so there is no unguarded path to fall into.
        context.app ?? requireDispatchApp(),
      )

      const text = result.content[0]?.text ?? ''
      if (result.isError) {
        throw new Error(text || `Tool execution failed: ${toolName}`)
      }
      return parseToolResultText(text)
    },

    getToolDefinitions(): ToolDefinition[] {
      return generateToolDefinitions(tools, context.roles)
    },
  }
}

/**
 * The package executor returns tool results as serialized text. Parse JSON back
 * to structured data for the AI assistant; fall back to the raw string when the
 * result was a plain (non-JSON) string.
 */
function parseToolResultText(text: string): unknown {
  if (!text) return { success: true }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
