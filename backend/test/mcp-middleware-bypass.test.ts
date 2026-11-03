// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// MCP and AI-chat tools must run admin routes through the real Elysia pipeline: forwarded auth, the role gate, and the audit hook.
import { describe, it, expect, afterAll, mock, spyOn } from 'bun:test'
import { Elysia, t } from 'elysia'

const actor = (token: string) => ({ sub: `sub-of-${token}`, username: 'audit-tester', email: 'audit@example.com' })
mock.module('../src/lib/auth', () => ({
  validateToken: mock(async (token: string) => {
    const { sub, username, email } = actor(token)
    return { sub, preferred_username: username, email, realm_access: { roles: ['admin'] }, resource_access: {} }
  }),
}))

import { adminAuditPlugin } from '../src/lib/admin-audit-middleware'
import { adminAuditLogger } from '../src/lib/admin-audit-logger'
import { extractBearerToken } from '../src/lib/admin-utils'
import { extractRouteTools, createToolExecutor } from '../src/lib/ai/tool-registry'
import { requireRecord } from '../src/lib/type-guards'
import { executeTool } from '@maxhealth.tech/elysia-mcp'
import { requireTool } from './helpers/tool-schema'

/** The real audit plugin around a mutation, mounted under a root app as admin routes are in production. */
function createAuditedAdminApp() {
  const handled: string[] = []
  const adminSubApp = new Elysia({ prefix: '/admin' })
    .use(adminAuditPlugin)
    .post(
      '/widgets',
      ({ headers, body, set }) => {
        const token = extractBearerToken(headers)
        if (!token) {
          set.status = 401
          return { error: 'Authorization header required' }
        }
        handled.push(body.name)
        return { created: true, tokenSeen: token }
      },
      { body: t.Object({ name: t.String() }) },
    )
  return { app: new Elysia().use(adminSubApp), handled }
}

// Tests in this file run concurrently against one process-wide logger, so each owns a token and reads only its actor's events.
const logSpy = spyOn(adminAuditLogger, 'log').mockImplementation(async () => {})

afterAll(() => {
  logSpy.mockRestore()
})

let tokens = 0
const uniqueToken = () => `admin-token-${++tokens}`

const settleHooks = () => new Promise((r) => setTimeout(r, 20))

function eventsBy(token: string) {
  return logSpy.mock.calls
    .map(([event]) => event)
    .filter((event) => event.actor.sub === actor(token).sub)
    .map(({ durationMs: _duration, ...event }) => event)
}

/** The audit events written for this token once `count` arrived; the onAfterResponse hook runs after the response. */
async function auditedEvents(token: string, count = 1) {
  const start = Date.now()
  while (eventsBy(token).length < count && Date.now() - start < 500) {
    await new Promise((r) => setTimeout(r, 5))
  }
  await settleHooks()
  return eventsBy(token)
}

function widgetPost(body: unknown, token: string) {
  return new Request('http://localhost/admin/widgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

describe('MCP middleware bypass — audit logging (a)', () => {
  it('baseline: a real HTTP dispatch of the mutation is audited with its actor', async () => {
    const token = uniqueToken()
    const { app } = createAuditedAdminApp()
    const res = await app.handle(widgetPost({ name: 'gizmo' }, token))
    expect(res.status).toBe(200)

    const events = await auditedEvents(token)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      method: 'POST',
      action: 'create',
      path: '/admin/widgets',
      resource: 'widgets',
      statusCode: 200,
      success: true,
      actor: actor(token),
    })
  })

  it('the executor path (as the MCP endpoint uses it) audits the mutation exactly as HTTP does', async () => {
    const token = uniqueToken()
    const { app, handled } = createAuditedAdminApp()
    const meta = requireTool(extractRouteTools(app, { prefixes: ['/admin/'] }), 'create_admin_widgets')

    await app.handle(widgetPost({ name: 'gizmo' }, token))
    const [viaHttp] = await auditedEvents(token)

    const result = await executeTool('create_admin_widgets', meta, { name: 'gizmo' }, token, app)
    expect(result.isError).toBeUndefined()

    const events = await auditedEvents(token, 2)
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual(viaHttp)
    expect(handled).toEqual(['gizmo', 'gizmo'])
  })
})

describe('AI-chat executor — auth forwarding + contract + audit (d)', () => {
  it('invoking a route-derived tool MUST forward the bearer token to the handler', async () => {
    const token = uniqueToken()
    const { app } = createAuditedAdminApp()
    const executor = createToolExecutor(extractRouteTools(app, { prefixes: ['/admin/'] }), {
      userId: actor(token).sub,
      roles: ['admin'],
      email: actor(token).email,
      token,
      app,
    })

    const result = requireRecord(await executor.execute('create_admin_widgets', { name: 'gizmo' }), 'tool result')

    expect(result).toEqual({ created: true, tokenSeen: token })
    await settleHooks()
  })

  it('invoking a route-derived tool MUST be audited (pipeline dispatch), naming the caller', async () => {
    const token = uniqueToken()
    const { app } = createAuditedAdminApp()
    const executor = createToolExecutor(extractRouteTools(app, { prefixes: ['/admin/'] }), {
      userId: actor(token).sub,
      roles: ['admin'],
      token,
      app,
    })

    await executor.execute('create_admin_widgets', { name: 'gizmo' })

    const events = await auditedEvents(token)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'create', path: '/admin/widgets', statusCode: 200, actor: actor(token) })
  })
})

describe('AI-chat executor — role gate', () => {
  it('refuses a non-public route tool to a caller without the admin role, before it runs', async () => {
    const token = uniqueToken()
    const { app, handled } = createAuditedAdminApp()
    const executor = createToolExecutor(extractRouteTools(app, { prefixes: ['/admin/'] }), {
      userId: 'someone',
      roles: ['user'],
      token,
      app,
    })

    await expect(executor.execute('create_admin_widgets', { name: 'gizmo' })).rejects.toThrow('requires admin role')

    expect(handled).toEqual([])
    expect(await auditedEvents(token)).toEqual([])
  })

  it('does not offer that tool to a caller without the admin role', () => {
    const { app } = createAuditedAdminApp()
    const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
    const offered = (roles: string[]) =>
      createToolExecutor(tools, { userId: 'u', roles, app }).getToolDefinitions().map((d) => d.function.name)

    expect(offered(['admin'])).toContain('create_admin_widgets')
    expect(offered(['user'])).not.toContain('create_admin_widgets')
  })
})
