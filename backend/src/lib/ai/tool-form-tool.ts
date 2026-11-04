// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { PrefabApp } from '@maxhealth.tech/prefab'
import { toolForm, labelFromToolName, uiToolMeta } from '@maxhealth.tech/elysia-mcp/prefab'
import type { ToolMetadata } from '@maxhealth.tech/elysia-mcp'
import { getToolRegistry, isToolRegistryInitialized } from './tool-registry'
import { isToolExposed } from '../mcp-endpoint-config'

/** Write tools only, filtered exactly as tool registration filters them, so no form targets an uncallable tool. */
function buildFormIndex(userRoles: string[]): Map<string, ToolMetadata> {
  if (!isToolRegistryInitialized()) return new Map()

  const index = new Map<string, ToolMetadata>()
  for (const [toolName, meta] of getToolRegistry()) {
    if (meta.readOnly) continue
    if (!isToolExposed(toolName)) continue
    if (!meta.public && !userRoles.includes('admin')) continue
    index.set(toolName, meta)
  }
  return index
}

function buildDescription(tools: Map<string, ToolMetadata>): string {
  const names = [...tools.keys()].sort()
  return [
    'Show an interactive form for one of the write tools, so the user fills in the arguments instead of the model guessing them.',
    'Returns a UI built from that tool\'s own input schema; submitting it calls the tool.',
    'Use this for anything a person should confirm or type themselves — creating a client, editing a user, changing a configuration.',
    'Pass `values` to pre-fill fields, which is also how a form for a specific record is bound to it (e.g. { userId: "abc123" }).',
    '',
    'Available tools:',
    names.map(n => `  - ${n}`).join('\n'),
  ].join('\n')
}

/** What the model is told, so a host with no UI still learns what was asked for. */
function describeForm(toolName: string, meta: ToolMetadata): string {
  return `Rendered the form for ${toolName} (${meta.method} ${meta.path}). Submitting it calls ${toolName}; nothing has been changed yet.`
}

/** `show_form`: a prefab form built from the target tool's own input schema, so form and validation cannot drift. */
export function registerToolFormTool(server: McpServer, userRoles: string[]): void {
  const tools = buildFormIndex(userRoles)
  if (tools.size === 0) return

  server.registerTool(
    'show_form',
    {
      description: buildDescription(tools),
      inputSchema: z.object({
        tool: z.string().describe('Name of the tool to draw a form for (e.g. create_admin_roles)'),
        values: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Pre-filled field values, keyed by argument name'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: uiToolMeta(),
    },
    ({ tool, values }) => {
      const meta = tools.get(tool)
      if (!meta) {
        const available = [...tools.keys()].sort().join(', ')
        return {
          content: [{ type: 'text' as const, text: `No form available for "${tool}". Tools with forms: ${available}` }],
          isError: true,
        }
      }

      const form = toolForm(tool, meta, { ...(values && { values }) })
      if (!form) {
        return {
          content: [{
            type: 'text' as const,
            text: `${tool} takes no arguments a form can ask for — call it directly.`,
          }],
          isError: true,
        }
      }

      const app = new PrefabApp({ title: labelFromToolName(tool), view: form })
      return {
        content: [{ type: 'text' as const, text: describeForm(tool, meta) }],
        structuredContent: app.toJSON(),
      }
    },
  )
}
