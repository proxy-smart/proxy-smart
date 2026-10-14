/**
 * Tool Registry — getMergedInputSchema Regression Tests
 *
 * Reproduces the "Unknown type" bug where merging body + path param schemas
 * stripped TypeBox [Kind] symbols, causing Value.Check() to throw.
 *
 * Root cause: The old implementation used JSON.parse(JSON.stringify()) which
 * removes Symbol metadata that TypeBox requires for type identification.
 * Fix: Use Type.Object() constructor to preserve [Kind] symbols.
 */

import { describe, it, expect } from 'bun:test'
import { Type, Kind, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { getMergedInputSchema, type ToolMetadata } from '../src/lib/ai/tool-registry'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal ToolMetadata for testing schema merging */
function fakeTool(opts: {
  bodySchema?: TSchema
  paramsSchema?: TSchema
}): ToolMetadata {
  return {
    path: '/admin/test/:id',
    method: 'PUT',
    handler: () => {},
    schema: opts.bodySchema,
    paramsSchema: opts.paramsSchema,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getMergedInputSchema', () => {
  // ── Basic merging ────────────────────────────────────────────────────

  it('returns undefined when both schemas are missing', () => {
    const result = getMergedInputSchema(fakeTool({}))
    expect(result).toBeUndefined()
  })

  it('returns bodySchema directly when no paramsSchema', () => {
    const body = Type.Object({ name: Type.String() })
    const result = getMergedInputSchema(fakeTool({ bodySchema: body }))
    expect(result).toBe(body) // same reference
  })

  it('returns paramsSchema directly when no bodySchema', () => {
    const params = Type.Object({ id: Type.String() })
    const result = getMergedInputSchema(fakeTool({ paramsSchema: params }))
    expect(result).toBe(params) // same reference
  })

  it('merges body + path params into a single schema with all properties', () => {
    const body = Type.Object({ name: Type.String(), email: Type.Optional(Type.String()) })
    const params = Type.Object({ userId: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))

    expect(merged).toBeDefined()
    const props = (merged as Record<string, unknown>).properties as Record<string, unknown>
    expect(props.name).toBeDefined()
    expect(props.email).toBeDefined()
    expect(props.userId).toBeDefined()
  })

  // ── [Kind] symbol preservation (the actual bug) ──────────────────────

  it('REGRESSION: merged schema preserves TypeBox [Kind] symbol', () => {
    const body = Type.Object({ description: Type.Optional(Type.String()) })
    const params = Type.Object({ roleName: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))

    // The old JSON.parse(JSON.stringify()) approach stripped this symbol
    expect((merged as unknown as Record<symbol | string, unknown>)[Kind]).toBe('Object')
  })

  it('REGRESSION: merged property schemas preserve [Kind] symbols', () => {
    const body = Type.Object({
      name: Type.String(),
      count: Type.Optional(Type.Number()),
      tags: Type.Optional(Type.Array(Type.String())),
    })
    const params = Type.Object({ id: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))

    const props = (merged as Record<string, unknown>).properties as Record<string, Record<symbol | string, unknown>>
    // Every property must retain its [Kind] symbol
    for (const [_key, schema] of Object.entries(props)) {
      expect(schema[Kind]).toBeDefined()
    }
  })

  it('REGRESSION: Value.Check does NOT throw "Unknown type" on merged schema', () => {
    const body = Type.Object({
      description: Type.Optional(Type.String()),
      fhirScopes: Type.Optional(Type.Array(Type.String())),
    })
    const params = Type.Object({ roleName: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    // This is the exact call that threw "Unknown type" before the fix
    expect(() => {
      Value.Check(merged, { roleName: 'test-role', description: 'updated' })
    }).not.toThrow()
  })

  it('REGRESSION: Value.Check validates correctly on merged schema', () => {
    const body = Type.Object({
      name: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    })
    const params = Type.Object({ clientId: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    // Valid args
    expect(Value.Check(merged, { clientId: 'app-1', name: 'My App' })).toBe(true)
    expect(Value.Check(merged, { clientId: 'app-1', name: 'My App', enabled: false })).toBe(true)

    // Invalid: missing required 'name'
    expect(Value.Check(merged, { clientId: 'app-1' })).toBe(false)

    // Invalid: wrong type for 'enabled'
    expect(Value.Check(merged, { clientId: 'app-1', name: 'X', enabled: 'yes' })).toBe(false)
  })

  // ── Required field merging ───────────────────────────────────────────

  it('merges required fields from both schemas', () => {
    const body = Type.Object({ name: Type.String() }) // name is required
    const params = Type.Object({ id: Type.String() }) // id is required
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    const required = (merged as Record<string, unknown>).required as string[]
    expect(required).toContain('name')
    expect(required).toContain('id')
  })

  it('path params override body properties with the same name', () => {
    // Edge case: both schemas define same property — params should win
    const body = Type.Object({ id: Type.Number(), name: Type.String() })
    const params = Type.Object({ id: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    const props = (merged as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
    // Path param version (String) should win over body version (Number)
    expect(props.id.type).toBe('string')
  })

  // ── Complex schemas (simulating real route schemas) ──────────────────

  it('handles schemas with Union types (common in update routes)', () => {
    const body = Type.Object({
      status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('disabled')])),
      config: Type.Optional(Type.Object({ key: Type.String() })),
    })
    const params = Type.Object({ name: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    expect(() => {
      Value.Check(merged, { name: 'test', status: 'active' })
    }).not.toThrow()
    expect(Value.Check(merged, { name: 'test', status: 'active' })).toBe(true)
    expect(Value.Check(merged, { name: 'test', status: 'invalid' })).toBe(false)
  })

  it('handles all-optional body (PATCH semantics) with required path param', () => {
    // This is the exact pattern that broke — PATCH routes have optional body fields
    const body = Type.Partial(Type.Object({
      displayName: Type.String(),
      enabled: Type.Boolean(),
      url: Type.String(),
    }))
    const params = Type.Object({ serverId: Type.String() })
    const merged = getMergedInputSchema(fakeTool({ bodySchema: body, paramsSchema: params }))!

    // Only serverId is required (from params), body fields are all optional
    expect(Value.Check(merged, { serverId: 'srv-1' })).toBe(true)
    expect(Value.Check(merged, { serverId: 'srv-1', displayName: 'Updated' })).toBe(true)
    expect(Value.Check(merged, { serverId: 'srv-1', enabled: true, url: 'https://x.com' })).toBe(true)

    // Missing required path param
    expect(Value.Check(merged, { displayName: 'No ID' })).toBe(false)
  })
})
