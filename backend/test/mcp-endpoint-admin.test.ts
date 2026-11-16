// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The AI tools tab turns prefab UIs on or off. MCP_PREFAB_UI stays the default
 * until an admin chooses, and choosing null hands back to it.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: 'u', realm_access: { roles: ['admin'] } })),
}))

const { mcpEndpointAdminRoutes } = await import('../src/routes/admin/mcp-endpoint')
const { loadMcpEndpointConfig, saveMcpEndpointConfig } = await import('../src/lib/mcp-endpoint-config')

const AUTH = { Authorization: 'Bearer token' }

async function status(init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await mcpEndpointAdminRoutes.handle(new Request('http://localhost/mcp-endpoint/', { ...init, headers: { ...AUTH, ...init.headers } }))
  expect(res.status).toBe(200)
  return res.json()
}

const patch = (body: Record<string, unknown>) =>
  status({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('admin MCP endpoint: prefab UIs', () => {
  let before: ReturnType<typeof loadMcpEndpointConfig>
  let envBefore: string | undefined

  beforeEach(async () => {
    before = loadMcpEndpointConfig()
    envBefore = process.env.MCP_PREFAB_UI
    await saveMcpEndpointConfig({ ...before, prefabUi: null })
  })

  afterEach(async () => {
    if (envBefore === undefined) delete process.env.MCP_PREFAB_UI
    else process.env.MCP_PREFAB_UI = envBefore
    await saveMcpEndpointConfig(before)
  })

  it('reports the deployment default while no admin has chosen', async () => {
    process.env.MCP_PREFAB_UI = 'true'
    expect(await status()).toMatchObject({ prefabUi: true, prefabUiDefault: true, prefabUiOverride: null })
  })

  it("keeps an admin's choice over the default, and null hands back to it", async () => {
    delete process.env.MCP_PREFAB_UI
    expect(await patch({ prefabUi: true })).toMatchObject({ prefabUi: true, prefabUiDefault: false, prefabUiOverride: true })
    expect(loadMcpEndpointConfig().prefabUi).toBe(true)

    expect(await patch({ prefabUi: null })).toMatchObject({ prefabUi: false, prefabUiOverride: null })
  })

  it('leaves the choice alone when another setting changes', async () => {
    await patch({ prefabUi: true })
    expect(await patch({ exposeResourcesAsTools: false })).toMatchObject({ prefabUi: true, prefabUiOverride: true })
  })
})
