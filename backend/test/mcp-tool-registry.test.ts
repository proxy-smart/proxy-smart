// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Route introspection into MCP / AI-chat tools, and executing those tools through the app's own pipeline.
import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import {
  createToolExecutor,
  extractRouteTools,
  generateToolDefinitions,
  getMergedInputSchema,
} from '../src/lib/ai/tool-registry'
import { propertySchema, requireTool, schemaProperties, schemaRequired } from './helpers/tool-schema'

function createTestApp() {
  return new Elysia()
    .post('/admin/users', ({ body }) => ({ created: true, ...body }), {
      body: t.Object({
        name: t.String({ minLength: 1, description: 'User name' }),
        email: t.String({ format: 'email', description: 'Email address' }),
        age: t.Optional(t.Number({ minimum: 0 })),
      }),
    })
    .put('/admin/users/:userId', ({ body, params }) => ({ updated: true, userId: params.userId, ...body }), {
      params: t.Object({
        userId: t.String({ description: 'User ID' }),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
      }),
    })
    .delete('/admin/users/:userId', ({ params }) => ({ deleted: true, userId: params.userId }), {
      params: t.Object({
        userId: t.String({ description: 'User ID' }),
      }),
    })
    .delete('/admin/launch-contexts/:userId/patient/:patientId', ({ params }) => ({ removed: params }), {
      params: t.Object({ userId: t.String(), patientId: t.String() }),
    })
    .post('/admin/ai/chat', ({ body }) => ({ reply: `Echo: ${body.message}` }), {
      body: t.Object({
        message: t.String({ minLength: 1, description: 'User message' }),
        conversationId: t.Optional(t.String()),
        model: t.Optional(t.String()),
      }),
    })
    .post('/admin/restart', () => ({ success: true, message: 'Restarted' }))
    .get('/admin/health', () => ({ status: 'ok' }))
    .post('/public/other', () => ({ nope: true }))
}

const app = createTestApp()
const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
const tool = (name: string) => requireTool(tools, name)

describe('Tool Registry — Schema Extraction', () => {
  it('extracts POST/PUT/DELETE routes under /admin/', () => {
    const names = Array.from(tools.keys())
    expect(names).toContain('create_admin_users')
    expect(names).toContain('update_admin_users_userId')
    expect(names).toContain('delete_admin_users_userId')
    expect(names).toContain('create_admin_ai_chat')
    expect(names).toContain('create_admin_restart')
  })

  it('includes GET routes as read-only tools', () => {
    expect(tool('get_admin_health')).toMatchObject({ readOnly: true, method: 'GET' })
  })

  it('skips routes outside the prefix', () => {
    expect(Array.from(tools.keys()).some(n => n.includes('public'))).toBe(false)
  })

  it('extracts body schema with correct properties for POST with body', () => {
    const { schema } = tool('create_admin_ai_chat')
    expect(schema?.type).toBe('object')
    expect(Object.keys(schemaProperties(schema)).sort()).toEqual(['conversationId', 'message', 'model'])
  })

  it('extracts required fields from schema', () => {
    expect(schemaRequired(tool('create_admin_ai_chat').schema)).toEqual(['message'])
  })

  it('extracts body schema for user creation with minLength', () => {
    const { schema } = tool('create_admin_users')
    expect(propertySchema(schema, 'name')).toMatchObject({ type: 'string', minLength: 1 })
    expect(propertySchema(schema, 'email')).toMatchObject({ type: 'string', format: 'email' })
  })

  it('has no schema for routes without body validation', () => {
    expect(tool('create_admin_restart').schema).toBeUndefined()
  })

  it('stores the handler function', () => {
    expect(typeof tool('create_admin_ai_chat').handler).toBe('function')
  })

  it('stores the correct HTTP method and path', () => {
    expect(tool('create_admin_ai_chat')).toMatchObject({ method: 'POST', path: '/admin/ai/chat' })
    expect(tool('delete_admin_users_userId')).toMatchObject({ method: 'DELETE', path: '/admin/users/:userId' })
  })

  it('extracts paramsSchema for routes with path parameters', () => {
    const { paramsSchema } = tool('update_admin_users_userId')
    expect(paramsSchema?.type).toBe('object')
    expect(Object.keys(schemaProperties(paramsSchema))).toEqual(['userId'])
  })

  it('has no paramsSchema for routes without path parameters', () => {
    expect(tool('create_admin_ai_chat').paramsSchema).toBeUndefined()
  })

  it('extracts paramsSchema for delete routes (no body)', () => {
    const deleteTool = tool('delete_admin_users_userId')
    expect(Object.keys(schemaProperties(deleteTool.paramsSchema))).toEqual(['userId'])
    expect(deleteTool.schema).toBeUndefined()
  })
})

describe('Tool Registry — getMergedInputSchema', () => {
  it('returns body schema when no params', () => {
    const merged = getMergedInputSchema(tool('create_admin_ai_chat'))
    expect(merged?.type).toBe('object')
    expect(Object.keys(schemaProperties(merged))).not.toContain('userId')
    expect(Object.keys(schemaProperties(merged))).toContain('message')
  })

  it('returns params schema when no body (DELETE with params)', () => {
    const merged = getMergedInputSchema(tool('delete_admin_users_userId'))
    expect(merged?.type).toBe('object')
    expect(Object.keys(schemaProperties(merged))).toEqual(['userId'])
  })

  it('merges body + params into single schema (PUT with both)', () => {
    const merged = getMergedInputSchema(tool('update_admin_users_userId'))
    expect(merged?.type).toBe('object')
    expect(Object.keys(schemaProperties(merged)).sort()).toEqual(['email', 'name', 'userId'])
  })

  it('includes path params in required array', () => {
    expect(schemaRequired(getMergedInputSchema(tool('update_admin_users_userId')))).toContain('userId')
  })

  it('returns undefined when neither body nor params', () => {
    expect(getMergedInputSchema(tool('create_admin_restart'))).toBeUndefined()
  })
})

describe('Tool Registry — Tool Name Generation', () => {
  it('generates create_ prefix for POST routes', () => {
    expect(tools.has('create_admin_users')).toBe(true)
    expect(tools.has('create_admin_ai_chat')).toBe(true)
    expect(tools.has('create_admin_restart')).toBe(true)
  })

  it('generates update_ prefix for PUT routes', () => {
    expect(tools.has('update_admin_users_userId')).toBe(true)
  })

  it('generates delete_ prefix for DELETE routes', () => {
    expect(tools.has('delete_admin_users_userId')).toBe(true)
  })
})

describe('Tool Registry — OpenAI tool definitions', () => {
  const definitions = generateToolDefinitions(tools, ['admin'])
  const parameters = (name: string) => definitions.find((d) => d.function.name === name)?.function.parameters

  it('describes a route body as a closed object with its required fields', () => {
    expect(JSON.parse(JSON.stringify(parameters('create_admin_ai_chat')))).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string', minLength: 1 }, conversationId: { type: 'string' }, model: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    })
  })

  it('folds path parameters into the parameters the model must supply', () => {
    expect(parameters('update_admin_users_userId')?.required).toContain('userId')
  })

  it('gives a route without inputs an empty closed object', () => {
    expect(parameters('create_admin_restart')).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })
})

describe('Tool Registry — execution through the app pipeline', () => {
  const executor = createToolExecutor(tools, { userId: 'u', roles: ['admin'], token: 'token', app })

  it('sends the args as the route body', async () => {
    expect(await executor.execute('create_admin_ai_chat', { message: 'Hello!' })).toEqual({ reply: 'Echo: Hello!' })
  })

  it('interpolates a path parameter and leaves it out of the body', async () => {
    expect(await executor.execute('delete_admin_users_userId', { userId: 'user-123' })).toEqual({ deleted: true, userId: 'user-123' })
  })

  it('splits args between path parameters and body', async () => {
    expect(await executor.execute('update_admin_users_userId', { userId: 'user-456', name: 'Jane' }))
      .toEqual({ updated: true, userId: 'user-456', name: 'Jane' })
  })

  it('interpolates several path parameters', async () => {
    expect(await executor.execute('delete_admin_launch-contexts_userId_patient_patientId', { userId: 'user-1', patientId: 'patient-2', extra: 'ignored' }))
      .toEqual({ removed: { userId: 'user-1', patientId: 'patient-2' } })
  })

  it('runs a bodyless route', async () => {
    expect(await executor.execute('create_admin_restart', {})).toEqual({ success: true, message: 'Restarted' })
  })

  it('refuses args missing a path parameter before dispatching', async () => {
    await expect(executor.execute('delete_admin_users_userId', { name: 'no-id-here' })).rejects.toThrow('Validation error')
  })

  it('refuses args the body schema rejects', async () => {
    await expect(executor.execute('create_admin_ai_chat', { message: '' })).rejects.toThrow('Validation error')
  })
})
