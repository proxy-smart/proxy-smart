// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/elysia-mcp - Tests
 *
 * Unit tests for route introspection, TypeBox-to-Zod bridge, and tool execution.
 */

import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { mountRoutes } from './helpers/mount'
import { Type } from '@sinclair/typebox'
import {
  extractRouteTools,
  extractRouteResources,
  annotationsForMethod,
  pathToToolName,
  pathToResourceName,
  pathToResourceUri,
} from '../src/introspect'
import { typeboxToSchema, getMergedInputSchema } from '../src/typebox-schema'
import { executeTool, executeResource } from '../src/executor'
import type { ToolMetadata, ResourceMetadata } from '../src/types'

// ── Introspect tests ─────────────────────────────────────────────────────────

describe('pathToToolName', () => {
  it('generates correct names for POST routes', () => {
    expect(pathToToolName('/admin/users', 'POST')).toBe('create_admin_users')
  })

  it('generates correct names for PUT routes with params', () => {
    expect(pathToToolName('/admin/users/:userId', 'PUT')).toBe('update_admin_users_userId')
  })

  it('generates correct names for DELETE routes', () => {
    expect(pathToToolName('/admin/roles/:roleName', 'DELETE')).toBe('delete_admin_roles_roleName')
  })

  it('generates correct names for GET routes', () => {
    expect(pathToToolName('/admin/branding', 'GET')).toBe('get_admin_branding')
  })

  it('handles nested paths', () => {
    expect(pathToToolName('/admin/scope-sets/templates', 'POST')).toBe('create_admin_scope-sets_templates')
  })
})

describe('pathToResourceName', () => {
  it('converts simple paths', () => {
    expect(pathToResourceName('/admin/branding')).toBe('admin_branding')
  })

  it('converts parameterized paths', () => {
    expect(pathToResourceName('/admin/roles/:roleName')).toBe('admin_roles_by_roleName')
  })

  it('replaces hyphens with underscores', () => {
    expect(pathToResourceName('/admin/scope-sets/templates')).toBe('admin_scope_sets_templates')
  })
})

describe('pathToResourceUri', () => {
  it('generates static URIs', () => {
    expect(pathToResourceUri('/admin/branding', 'myapp')).toBe('myapp://admin/branding')
  })

  it('generates URI templates for parameterized paths', () => {
    expect(pathToResourceUri('/admin/roles/:roleName', 'myapp')).toBe('myapp://admin/roles/{roleName}')
  })

  it('uses default scheme', () => {
    expect(pathToResourceUri('/api/data')).toBe('app://api/data')
  })
})

describe('extractRouteTools', () => {
  it('extracts tools from routes matching prefixes', () => {
    const mockApp = {
      routes: [
        { path: '/admin/users', method: 'POST', handler: () => 'ok', hooks: { body: Type.Object({ name: Type.String() }) } },
        { path: '/admin/users/:id', method: 'GET', handler: () => 'ok', hooks: { params: Type.Object({ id: Type.String() }) } },
        { path: '/public/health', method: 'GET', handler: () => 'ok' },
      ],
    }

    const tools = extractRouteTools(mockApp, { prefixes: ['/admin/'] })
    expect(tools.size).toBe(2)
    expect(tools.has('create_admin_users')).toBe(true)
    expect(tools.has('get_admin_users_id')).toBe(true)
    expect(tools.has('get_public_health')).toBe(false)
  })

  it('skips HEAD and OPTIONS routes', () => {
    const mockApp = {
      routes: [
        { path: '/admin/test', method: 'HEAD', handler: () => 'ok' },
        { path: '/admin/test', method: 'OPTIONS', handler: () => 'ok' },
        { path: '/admin/test', method: 'POST', handler: () => 'ok' },
      ],
    }

    const tools = extractRouteTools(mockApp, { prefixes: ['/admin/'] })
    expect(tools.size).toBe(1)
    expect(tools.has('create_admin_test')).toBe(true)
  })

  it('marks GET routes as readOnly', () => {
    const mockApp = {
      routes: [
        { path: '/admin/data', method: 'GET', handler: () => 'ok' },
        { path: '/admin/data', method: 'POST', handler: () => 'ok' },
      ],
    }

    const tools = extractRouteTools(mockApp, { prefixes: ['/admin/'] })
    expect(tools.get('get_admin_data')?.readOnly).toBe(true)
    expect(tools.get('create_admin_data')?.readOnly).toBe(false)
  })

  it('reads meta.public annotation', () => {
    const mockApp = {
      routes: [
        { path: '/api/public-data', method: 'GET', handler: () => 'ok', meta: { public: true } },
      ],
    }

    const tools = extractRouteTools(mockApp, { prefixes: ['/api/'] })
    expect(tools.get('get_api_public-data')?.public).toBe(true)
  })
})

describe('extractRouteResources', () => {
  it('extracts only GET routes', () => {
    const mockApp = {
      routes: [
        { path: '/admin/branding', method: 'GET', handler: () => 'ok' },
        { path: '/admin/branding', method: 'PUT', handler: () => 'ok' },
      ],
    }

    const resources = extractRouteResources(mockApp, { prefixes: ['/admin/'] })
    expect(resources.size).toBe(1)
    expect(resources.has('admin_branding')).toBe(true)
  })

  it('extracts path params', () => {
    const mockApp = {
      routes: [
        { path: '/admin/users/:userId/roles/:roleId', method: 'GET', handler: () => 'ok' },
      ],
    }

    const resources = extractRouteResources(mockApp, { prefixes: ['/admin/'] })
    const res = resources.get('admin_users_by_userId_roles_by_roleId')!
    expect(res.pathParams).toEqual(['userId', 'roleId'])
  })
})

// ── TypeBox-to-Standard-Schema tests ─────────────────────────────────────────

/** Run a Standard Schema's validator, which is how the MCP SDK invokes it. */
async function validate(schema: unknown, value: unknown) {
  const std = (schema as { '~standard': { validate: (v: unknown) => unknown } })['~standard']
  return await std.validate(value)
}

describe('typeboxToSchema', () => {
  it('produces a Standard Schema that accepts a valid value', async () => {
    const schema = typeboxToSchema(Type.Object({
      name: Type.String({ description: 'User name' }),
      age: Type.Number(),
    }))

    expect(schema).toBeDefined()
    const result = await validate(schema, { name: 'Ada', age: 36 })
    expect(result).toEqual({ value: { name: 'Ada', age: 36 } })
  })

  it('enforces the required array rather than re-deriving it', async () => {
    const schema = typeboxToSchema(Type.Object({
      name: Type.String(),
      bio: Type.Optional(Type.String()),
    }))

    // `bio` is absent and that is fine; `name` is not optional.
    expect(await validate(schema, { name: 'Ada' })).toEqual({ value: { name: 'Ada' } })
    expect(await validate(schema, { bio: 'no name' })).toHaveProperty('issues')
  })

  it('rejects a value of the wrong type', async () => {
    const schema = typeboxToSchema(Type.Object({ age: Type.Number() }))
    expect(await validate(schema, { age: 'thirty-six' })).toHaveProperty('issues')
  })

  it('returns undefined for non-object schemas', () => {
    expect(typeboxToSchema(Type.String())).toBeUndefined()
  })

  it('returns undefined for invalid input', () => {
    expect(typeboxToSchema('not a schema')).toBeUndefined()
  })
})

describe('getMergedInputSchema', () => {
  it('returns body schema when no params', () => {
    const bodySchema = Type.Object({ name: Type.String() })
    const meta: ToolMetadata = { path: '/test', method: 'POST', handler: () => {}, schema: bodySchema }
    const merged = getMergedInputSchema(meta)
    expect(merged).toBe(bodySchema)
  })

  it('returns params schema when no body', () => {
    const paramsSchema = Type.Object({ id: Type.String() })
    const meta: ToolMetadata = { path: '/test/:id', method: 'GET', handler: () => {}, paramsSchema }
    const merged = getMergedInputSchema(meta)
    expect(merged).toBe(paramsSchema)
  })

  it('merges body and params schemas', () => {
    const bodySchema = Type.Object({ name: Type.String() })
    const paramsSchema = Type.Object({ id: Type.String() })
    const meta: ToolMetadata = { path: '/test/:id', method: 'PUT', handler: () => {}, schema: bodySchema, paramsSchema }
    const merged = getMergedInputSchema(meta)!
    const props = (merged as { properties?: Record<string, unknown> }).properties
    expect(props).toBeDefined()
    expect(props!.name).toBeDefined()
    expect(props!.id).toBeDefined()
  })

  it('returns undefined when neither body nor params', () => {
    const meta: ToolMetadata = { path: '/test', method: 'POST', handler: () => {} }
    expect(getMergedInputSchema(meta)).toBeUndefined()
  })
})

// ── Executor tests ───────────────────────────────────────────────────────────

describe('executeTool', () => {
  it('executes a simple handler', async () => {
    const meta: ToolMetadata = {
      path: '/admin/test',
      method: 'POST',
      handler: (ctx: { body: { message: string } }) => ({ echo: ctx.body.message }),
    }

    const result = await executeTool('create_admin_test', meta, { message: 'hello' }, undefined, mountRoutes(meta))
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.echo).toBe('hello')
  })

  it('passes path params correctly', async () => {
    const meta: ToolMetadata = {
      path: '/admin/users/:userId',
      method: 'PUT',
      handler: (ctx: { params: { userId: string }; body: { name: string } }) => ({
        userId: ctx.params.userId,
        name: ctx.body.name,
      }),
    }

    const result = await executeTool('update_admin_users_userId', meta, { userId: '123', name: 'Alice' }, undefined, mountRoutes(meta))
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.userId).toBe('123')
    expect(parsed.name).toBe('Alice')
  })

  it('reports handler errors gracefully', async () => {
    const meta: ToolMetadata = {
      path: '/admin/fail',
      method: 'POST',
      handler: () => { throw new Error('Boom') },
    }

    const result = await executeTool('create_admin_fail', meta, {}, undefined, mountRoutes(meta))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Boom')
  })

  it('reports a route the app does not serve', async () => {
    // The executor no longer inspects meta.handler — the app decides what is
    // callable, because dispatch goes through it. A tool whose route is not
    // mounted is an error result, not a direct handler call.
    const meta: ToolMetadata = {
      path: '/admin/nohandler',
      method: 'POST',
      handler: () => 'never reached',
    }

    const result = await executeTool('create_admin_nohandler', meta, {}, undefined, new Elysia())
    expect(result.isError).toBe(true)
  })

  it('lets the app supply the handler its decorators', async () => {
    // Decorators used to be handed to the executor and spread into a synthetic
    // context. They come from the app now, which is where Elysia puts them —
    // so this exercises the mechanism a real deployment actually uses.
    const meta: ToolMetadata = {
      path: '/admin/decorated',
      method: 'POST',
      handler: () => ({ db: 'unused — dispatch goes through the app' }),
    }
    const app = new Elysia()
      .decorate('getDb', () => 'postgres')
      .post('/admin/decorated', ({ getDb }) => ({ db: getDb() }))

    const result = await executeTool('create_admin_decorated', meta, {}, undefined, app)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.db).toBe('postgres')
  })

  it('validates input against schema', async () => {
    const meta: ToolMetadata = {
      path: '/admin/strict',
      method: 'POST',
      handler: () => 'ok',
      schema: Type.Object({ name: Type.String() }),
    }

    const result = await executeTool('create_admin_strict', meta, { name: 123 as unknown as string }, undefined, mountRoutes(meta))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Validation error')
  })

  it('surfaces object results as structuredContent (with text fallback)', async () => {
    const meta: ToolMetadata = {
      path: '/admin/obj',
      method: 'POST',
      handler: () => ({ id: 'abc', ok: true }),
    }

    const result = await executeTool('create_admin_obj', meta, {}, undefined, mountRoutes(meta))
    expect(result.isError).toBeUndefined()
    // text block always present
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'abc', ok: true })
    // structured mirror present for object payloads
    expect(result.structuredContent).toEqual({ id: 'abc', ok: true })
  })

  it('surfaces array results as structuredContent too', async () => {
    const meta: ToolMetadata = {
      path: '/admin/list',
      method: 'POST',
      handler: () => [1, 2, 3],
    }

    const result = await executeTool('create_admin_list', meta, {}, undefined, mountRoutes(meta))
    expect(result.isError).toBeUndefined()
    // Arrays used to be dropped here because the 2025 wire shape requires
    // structuredContent to be an object. Reconciling that is the SDK's job:
    // projectCallToolResult wraps a non-object value as `{result:…}` for a
    // 2025-era client and passes it through on 2026. Dropping them here
    // discarded the structured half of the largest (list) responses, and would
    // contradict an advertised array-rooted outputSchema.
    expect(result.structuredContent).toEqual([1, 2, 3])
    expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3])
  })

  it('still omits structuredContent for primitives and unparseable text', async () => {
    // A bare primitive carries nothing the text block does not already, so it
    // would only add a `{result:…}` wrap on 2025-era clients for no gain.
    const primitive: ToolMetadata = { path: '/admin/n', method: 'POST', handler: () => 42 }
    expect((await executeTool('create_admin_n', primitive, {}, undefined, mountRoutes(primitive))).structuredContent).toBeUndefined()

    const plain: ToolMetadata = { path: '/admin/s', method: 'POST', handler: () => 'not json' }
    expect((await executeTool('create_admin_s', plain, {}, undefined, mountRoutes(plain))).structuredContent).toBeUndefined()
  })
})

describe('annotationsForMethod', () => {
  it('marks GET as read-only and idempotent', () => {
    expect(annotationsForMethod('GET')).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
  })

  it('marks DELETE as destructive and idempotent', () => {
    const a = annotationsForMethod('DELETE')
    expect(a.destructiveHint).toBe(true)
    expect(a.idempotentHint).toBe(true)
    expect(a.readOnlyHint).toBe(false)
  })

  it('marks PUT as idempotent but not destructive', () => {
    const a = annotationsForMethod('PUT')
    expect(a.idempotentHint).toBe(true)
    expect(a.destructiveHint).toBe(false)
  })

  it('marks POST as non-idempotent, non-destructive create', () => {
    const a = annotationsForMethod('post')
    expect(a.idempotentHint).toBe(false)
    expect(a.destructiveHint).toBe(false)
    expect(a.readOnlyHint).toBe(false)
  })

  it('always signals a closed world for admin routes', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(annotationsForMethod(m).openWorldHint).toBe(false)
    }
  })
})

describe('executeResource', () => {
  it('executes a GET handler', async () => {
    const meta: ResourceMetadata = {
      path: '/admin/branding',
      method: 'GET',
      handler: () => ({ logo: 'test.png' }),
      pathParams: [],
    }

    const result = await executeResource(meta, {}, undefined, mountRoutes(meta))
    const parsed = JSON.parse(result)
    expect(parsed.logo).toBe('test.png')
  })

  it('passes path params', async () => {
    const meta: ResourceMetadata = {
      path: '/admin/users/:userId',
      method: 'GET',
      handler: (ctx: { params: { userId: string } }) => ({ id: ctx.params.userId }),
      pathParams: ['userId'],
    }

    const result = await executeResource(meta, { userId: '456' }, undefined, mountRoutes(meta))
    const parsed = JSON.parse(result)
    expect(parsed.id).toBe('456')
  })

  it('surfaces a handler error to the caller', async () => {
    const meta: ResourceMetadata = {
      path: '/admin/broken',
      method: 'GET',
      handler: () => { throw new Error('DB down') },
      pathParams: [],
    }

    // The reason reaches the caller, but the envelope is Elysia's now rather
    // than the executor's own JSON wrapper — errors are handled by the pipeline
    // that runs the route. Asserting containment rather than a shape keeps this
    // from pinning framework internals.
    const result = await executeResource(meta, {}, undefined, mountRoutes(meta))
    expect(result).toContain('DB down')
  })
})
