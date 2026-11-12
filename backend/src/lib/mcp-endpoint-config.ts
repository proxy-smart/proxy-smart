// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Reads stay synchronous (served from adminConfigStore's short-TTL cache) for the config.mcp.enabled getter.

import { adminConfigStore } from './admin-config-store'
import { stringArray } from './type-guards'
import { pathToResourceName, pathToToolName } from '@maxhealth.tech/elysia-mcp'

export interface McpEndpointConfig {
  /** Overrides config.mcp.enabled at runtime. */
  enabled: boolean
  disabledTools: string[]
  /** Allowlist; null falls back to the disabledTools blocklist. */
  enabledTools: string[] | null
  exposeResourcesAsTools: boolean
  updatedAt: string
}

/** Also the filename stem (`mcp-endpoint.json`) in file mode. */
const CONFIG_KEY = 'mcp-endpoint'

const DEFAULT_CONFIG: McpEndpointConfig = {
  enabled: true,
  disabledTools: [],
  enabledTools: [],
  exposeResourcesAsTools: true,
  updatedAt: new Date().toISOString(),
}

function mergeConfig(
  defaults: McpEndpointConfig,
  raw: Record<string, unknown> | null,
): McpEndpointConfig {
  if (!raw) return { ...defaults }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    disabledTools: stringArray(raw.disabledTools) ?? [],
    enabledTools: stringArray(raw.enabledTools) ?? null,
    exposeResourcesAsTools:
      typeof raw.exposeResourcesAsTools === 'boolean'
        ? raw.exposeResourcesAsTools
        : defaults.exposeResourcesAsTools,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  }
}

export function loadMcpEndpointConfig(): McpEndpointConfig {
  return adminConfigStore.get<McpEndpointConfig>(CONFIG_KEY, DEFAULT_CONFIG, mergeConfig)
}

export async function saveMcpEndpointConfig(cfg: McpEndpointConfig): Promise<void> {
  cfg.updatedAt = new Date().toISOString()
  await adminConfigStore.set(CONFIG_KEY, cfg)
}

// Always exposed so admins cannot lock themselves out of re-enabling tools.
export const PROTECTED_ROUTES = [
  { method: 'GET', path: '/admin/mcp-endpoint/' },
  { method: 'PATCH', path: '/admin/mcp-endpoint/' },
  { method: 'PUT', path: '/admin/mcp-endpoint/tools/:toolName' },
] as const

const PROTECTED_TOOLS: ReadonlySet<string> = new Set(
  PROTECTED_ROUTES.flatMap(({ method, path }) =>
    method === 'GET' ? [pathToToolName(path, method), pathToResourceName(path)] : [pathToToolName(path, method)],
  ),
)

export function isToolExposed(toolName: string): boolean {
  if (PROTECTED_TOOLS.has(toolName)) return true
  const cfg = loadMcpEndpointConfig()
  if (cfg.enabledTools !== null) {
    return cfg.enabledTools.includes(toolName)
  }
  return !cfg.disabledTools.includes(toolName)
}

export function isResourceExposed(resourceName: string): boolean {
  return isToolExposed(resourceName)
}
