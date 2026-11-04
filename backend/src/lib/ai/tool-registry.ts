// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

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

export type { ToolMetadata, ResourceMetadata }

let globalTools: Map<string, ToolMetadata> | null = null
let globalResources: Map<string, ResourceMetadata> | null = null

/** Custom tools take `(args, ctx)` and run directly; route tools go through the HTTP pipeline. */
const customToolNames = new Set<string>()

interface DispatchApp {
  handle(request: Request): Promise<Response> | Response
}
let dispatchApp: DispatchApp | null = null

/** The root app, registered once all routes and global plugins are mounted, so guards and audit hooks run. */
export function setDispatchApp(app: DispatchApp): void {
  dispatchApp = app
}

/** Throws when unregistered, since there is no unguarded fallback. */
export function requireDispatchApp(): DispatchApp {
  if (!dispatchApp) {
    throw new Error('Dispatch app not registered — setDispatchApp() must run before tool execution')
  }
  return dispatchApp
}

/** OpenAI function-calling format. */
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

export { extractRouteTools, extractRouteResources, getMergedInputSchema }

export const PROXY_SMART_RESOURCE_SCHEME = 'proxy-smart'

/** An Elysia route path as an MCP resource URI in the proxy-smart scheme. */
export function proxySmartResourceUri(path: string): string {
  return pathToResourceUri(path, PROXY_SMART_RESOURCE_SCHEME)
}

/** Call once at startup, after all routes are mounted. */
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

/** Custom tools win a name clash with a route tool. */
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

function typeboxToOpenAI(schema: TSchema): ToolDefinition['function']['parameters'] {
  const properties: Record<string, unknown> = isRecord(schema.properties) ? schema.properties : {}
  const required = stringArray(schema.required)
  return { type: 'object', properties, ...(required && { required }), additionalProperties: false }
}

/** Non-public tools only for admins. */
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

export interface ToolExecutorContext {
  userId: string
  roles: string[]
  email?: string
  /** Forwarded as the bearer, so the route's own auth applies. */
  token?: string
  /** Defaults to the registered dispatch app. */
  app?: DispatchApp
}

/** Route tools run through the HTTP pipeline, authenticated, guarded and audited like a direct call. */
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

      if (customToolNames.has(toolName)) {
        const output: unknown = await handler(args, { user: context })
        return output
      }

      const result = await executeTool(
        toolName,
        tool,
        isRecord(args) ? args : {},
        context.token,
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

/** JSON back to data; a plain string stays a string. */
function parseToolResultText(text: string): unknown {
  if (!text) return { success: true }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
