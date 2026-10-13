/**
 * MCP / AI-chat Middleware-Bypass Security Tests (TDD)
 *
 * The backend exposes admin routes as MCP tools (mcp-endpoint.ts) and as
 * AI-chat tools (tool-registry.ts `createToolExecutor`). Both historically ran
 * route handlers by building a SYNTHETIC Elysia context and calling
 * `handler(ctx)` directly, bypassing Elysia's HTTP pipeline. That silently
 * skips every lifecycle hook / guard / response-schema.
 *
 * This file covers the two BACKEND-specific bypass classes:
 *
 *   (a) Audit logging bypass — `adminAuditPlugin` is implemented ONLY as
 *       `.onBeforeHandle` / `.onAfterResponse` scoped lifecycle hooks. A
 *       mutation invoked via the package executor never enters the lifecycle,
 *       so it is NOT audited. SECURE expectation: an executor-path mutation
 *       produces an `adminAuditLogger.log` call equivalent to the same mutation
 *       dispatched via `app.handle(new Request(...))`.
 *
 *   (d) AI-chat executor mismatch — `createToolExecutor.execute` calls
 *       `tool.handler(args, { user })`. Route-derived handlers expect a single
 *       `(ctx)` object and read `ctx.headers` / `ctx.getAdmin` / `ctx.body`,
 *       and NO bearer token is forwarded. SECURE expectation: a route-derived
 *       tool invoked through the executor forwards auth, uses the correct
 *       handler contract, and is audited.
 *
 * Tests assert the SECURE expectation, so they are RED until execution is
 * dispatched through the real Elysia pipeline. They reuse the REAL
 * `adminAuditPlugin`, the REAL package `executeTool`, the REAL `extractRouteTools`
 * introspection, and real route patterns.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from 'bun:test'
import { Elysia, t } from 'elysia'

// ── Mock auth so the audit plugin's JWT extraction resolves a known actor ─────

const TEST_SUB = 'audit-test-user'
mock.module('../src/lib/auth', () => ({
  validateToken: mock(async (_token: string) => ({
    sub: TEST_SUB,
    preferred_username: 'audit-tester',
    email: 'audit@example.com',
    realm_access: { roles: ['admin'] },
    resource_access: {},
  })),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

import { adminAuditPlugin } from '../src/lib/admin-audit-middleware'
import { adminAuditLogger } from '../src/lib/admin-audit-logger'
import { extractBearerToken } from '../src/lib/admin-utils'
import { extractRouteTools } from '../src/lib/ai/tool-registry'
import { executeTool as pkgExecuteTool } from '@maxhealth.tech/elysia-mcp'
import { createToolExecutor } from '../src/lib/ai/tool-registry'

// ── App under test ────────────────────────────────────────────────────────────

/**
 * Minimal admin app that mirrors the real composition order in
 * routes/admin/index.ts: the REAL adminAuditPlugin wraps a mutation route.
 * The route reads the bearer token from headers (like every real admin handler)
 * so we can also assert the AI-chat executor forwards auth.
 *
 * The audit plugin's hooks are `{ as: 'scoped' }`, so — exactly like production
 * where `adminRoutes` is `.use()`d into the root app in app-factory.ts — the
 * audited sub-app is wrapped in a ROOT Elysia instance. Dispatch must go through
 * the root for the scoped lifecycle (and prefixes) to resolve.
 */
function createAuditedAdminApp() {
  const adminSubApp = new Elysia({ prefix: '/admin' })
    .use(adminAuditPlugin)
    .post(
      '/widgets',
      ({ headers, set }) => {
        const token = extractBearerToken(headers as Record<string, string | undefined>)
        if (!token) {
          set.status = 401
          return { error: 'Authorization header required' }
        }
        return { created: true, tokenSeen: token }
      },
      { body: t.Object({ name: t.String() }) },
    )
  return new Elysia().use(adminSubApp)
}

/**
 * `adminAuditLogger.log` is a module singleton shared across the whole process.
 * Install ONE spy for the suite (beforeAll), clear it per test, restore it once
 * (afterAll). Restoring mid-suite races the async `.onAfterResponse` hook —
 * a late hook from a finished test would hit the real logger and pollute the
 * next test. A single persistent spy avoids that entirely.
 */
let logSpy: ReturnType<typeof spyOn>

beforeAll(() => {
  logSpy = spyOn(adminAuditLogger, 'log').mockImplementation(async () => {})
})

afterAll(() => {
  logSpy.mockRestore()
})

beforeEach(() => {
  logSpy.mockClear()
})

/**
 * `adminAuditPlugin` writes via `.onAfterResponse`, which fires AFTER the
 * response resolves. Poll the spy briefly so assertions don't race the hook.
 */
async function waitForAuditLog(timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (logSpy.mock.calls.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Let any pending `.onAfterResponse` microtask settle before the test ends, so
 * a late audit-hook never bleeds into the next test's cleared spy.
 */
async function settleHooks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

const VALID_TOKEN = 'valid-admin-token'

function mcpPost(body: unknown, token = VALID_TOKEN) {
  return new Request('http://localhost/admin/widgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP middleware bypass — audit logging (a)', () => {
  it('baseline: a real HTTP dispatch of the mutation is audited (sanity)', async () => {
    const app = createAuditedAdminApp()
    logSpy.mockClear()
    const res = await app.handle(mcpPost({ name: 'gizmo' }))
    expect(res.status).toBe(200)

    await waitForAuditLog()
    expect(logSpy).toHaveBeenCalled()
    const event = logSpy.mock.calls[0][0] as Record<string, unknown>
    expect(event.method).toBe('POST')
    expect(event.action).toBe('create')
    expect((event.path as string)).toContain('/admin/widgets')
    await settleHooks()
  })

  it('the executor path (as the MCP endpoint uses it) MUST also audit the mutation', async () => {
    const app = createAuditedAdminApp()
    const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
    const meta = tools.get('create_admin_widgets')!
    expect(meta).toBeDefined()

    // Invoke exactly the way mcp-endpoint.ts does: package executeTool with the
    // forwarded bearer token. The secure path must dispatch through the pipeline
    // (so adminAuditPlugin's onAfterResponse fires).
    // Clear immediately before the action so a late hook from a prior test's
    // async onAfterResponse cannot be miscounted as this test's audit.
    await settleHooks()
    logSpy.mockClear()
    const result = await pkgExecuteTool(
      'create_admin_widgets',
      meta,
      { name: 'gizmo' },
      VALID_TOKEN,
      app,
    )
    expect(result.isError).toBeUndefined()

    // SECURE expectation: the mutation was audited, equivalent to app.handle().
    await waitForAuditLog()
    expect(logSpy).toHaveBeenCalled()
    const event = logSpy.mock.calls[0][0] as Record<string, unknown>
    expect(event.method).toBe('POST')
    expect(event.action).toBe('create')
    expect((event.path as string)).toContain('/admin/widgets')
    await settleHooks()
  })
})

describe('AI-chat executor — auth forwarding + contract + audit (d)', () => {
  it('invoking a route-derived tool MUST forward the bearer token to the handler', async () => {
    const app = createAuditedAdminApp()
    const tools = extractRouteTools(app, { prefixes: ['/admin/'] })

    const executor = createToolExecutor(tools, {
      userId: TEST_SUB,
      roles: ['admin'],
      email: 'audit@example.com',
      token: VALID_TOKEN,
      app,
    })

    const result = (await executor.execute('create_admin_widgets', { name: 'gizmo' })) as {
      created?: boolean
      tokenSeen?: string
      error?: string
    }

    // Route handler returns 401 unless it can read the bearer token from headers.
    // SECURE expectation: token forwarded → handler succeeds and saw the token.
    expect(result.error).toBeUndefined()
    expect(result.created).toBe(true)
    expect(result.tokenSeen).toBe(VALID_TOKEN)
    await settleHooks()
  })

  it('invoking a route-derived tool MUST be audited (pipeline dispatch)', async () => {
    const app = createAuditedAdminApp()
    const tools = extractRouteTools(app, { prefixes: ['/admin/'] })

    const executor = createToolExecutor(tools, {
      userId: TEST_SUB,
      roles: ['admin'],
      token: VALID_TOKEN,
      app,
    })

    await settleHooks()
    logSpy.mockClear()
    await executor.execute('create_admin_widgets', { name: 'gizmo' })

    await waitForAuditLog()
    expect(logSpy).toHaveBeenCalled()
    const event = logSpy.mock.calls[0][0] as Record<string, unknown>
    expect(event.action).toBe('create')
    expect((event.path as string)).toContain('/admin/widgets')
    await settleHooks()
  })
})
