// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * MCP Endpoint Configuration — durable persistence for tool exposure settings.
 *
 * Backed by the shared {@link adminConfigStore}: PostgreSQL when DATABASE_URL is
 * set (cluster-safe, survives redeploys), otherwise the existing
 * `DATA_DIR/mcp-endpoint.json` file (local dev / current beta).
 *
 * The read API stays SYNCHRONOUS (`loadMcpEndpointConfig`, `isToolExposed`,
 * `isResourceExposed`) so the `config.mcp.enabled` getter and the tight
 * tool-registration loops do not need to become async. Reads come from the
 * store's short-TTL cache, so a write from one task is observed by all tasks
 * within seconds — replacing the previous indefinite cache that never re-read.
 *
 * `saveMcpEndpointConfig` is async (it may write to Postgres) but updates the
 * cache synchronously first, so unawaited callers still read the new value.
 */

import { adminConfigStore } from './admin-config-store'
import { stringArray } from './type-guards'

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpEndpointConfig {
  /** Master switch — overrides config.mcp.enabled at runtime */
  enabled: boolean
  /** Tool names explicitly disabled (blocklist). Empty = all exposed. */
  disabledTools: string[]
  /** When set, only these tools are exposed (allowlist). null = use blocklist mode. */
  enabledTools: string[] | null
  /** When true, read-only GET resources are also exposed as MCP tools with readOnlyHint annotation */
  exposeResourcesAsTools: boolean
  /** Last modified timestamp */
  updatedAt: string
}

// ── Persistence ────────────────────────────────────────────────────────────────

/** Storage key — also the filename stem (`mcp-endpoint.json`) in file mode. */
const CONFIG_KEY = 'mcp-endpoint'

const DEFAULT_CONFIG: McpEndpointConfig = {
  enabled: true,
  disabledTools: [],
  enabledTools: [],
  exposeResourcesAsTools: true,
  updatedAt: new Date().toISOString(),
}

/** Merge a persisted (partial) value onto defaults into a fully-typed config. */
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

/**
 * Tools that must always remain exposed — prevents locking yourself out.
 * The MCP config tool itself must always be reachable so admins can re-enable others.
 */
const PROTECTED_TOOLS = new Set([
  'update_admin_mcp-endpoint',
  'update_admin_mcp-endpoint_tools_toolName',
  'get_admin_mcp-endpoint',
])

/**
 * Check whether a specific tool should be exposed via the MCP endpoint.
 */
export function isToolExposed(toolName: string): boolean {
  if (PROTECTED_TOOLS.has(toolName)) return true
  const cfg = loadMcpEndpointConfig()
  // Allowlist mode takes priority
  if (cfg.enabledTools !== null) {
    return cfg.enabledTools.includes(toolName)
  }
  // Otherwise blocklist mode
  return !cfg.disabledTools.includes(toolName)
}

/**
 * Check whether a specific resource should be exposed via the MCP endpoint.
 * Reuses the same config mechanism as tools — resources share the allowlist/blocklist.
 */
export function isResourceExposed(resourceName: string): boolean {
  return isToolExposed(resourceName)
}
