// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, expect, it } from 'bun:test'
import '../src/routes/admin'
import { getToolRegistry } from '../src/lib/ai/tool-registry'
import {
  PROTECTED_ROUTES,
  isToolExposed,
  loadMcpEndpointConfig,
  saveMcpEndpointConfig,
} from '../src/lib/mcp-endpoint-config'

const original = loadMcpEndpointConfig()

afterAll(async () => {
  await saveMcpEndpointConfig(original)
})

describe('MCP endpoint lock-out protection', () => {
  const registered = [...getToolRegistry()].map(([name, meta]) => ({ name, method: meta.method, path: meta.path }))

  it.each(PROTECTED_ROUTES.map(route => [`${route.method} ${route.path}`, route] as const))(
    '%s is a registered admin route and stays exposed under an empty allowlist',
    async (_, route) => {
      const tool = registered.find(entry => entry.method === route.method && entry.path === route.path)
      expect(tool).toBeDefined()
      await saveMcpEndpointConfig({ ...original, enabledTools: [], disabledTools: [tool?.name ?? ''] })
      expect(isToolExposed(tool?.name ?? '')).toBe(true)
    },
  )
})
