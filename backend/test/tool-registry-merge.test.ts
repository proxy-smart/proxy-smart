// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Merging body and path-param schemas must keep TypeBox [Kind] symbols, or Value.Check throws "Unknown type".
import { describe, it, expect } from 'bun:test'
import { Type, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { getMergedInputSchema, type ToolMetadata } from '../src/lib/ai/tool-registry'
import { propertySchema, schemaProperties, schemaRequired, typeboxKind } from './helpers/tool-schema'

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

function merge(bodySchema: TSchema, paramsSchema: TSchema): TSchema {
  const merged = getMergedInputSchema(fakeTool({ bodySchema, paramsSchema }))
  if (!merged) throw new Error('body and params merged into nothing')
  return merged
}

describe('getMergedInputSchema', () => {
  it('returns undefined when both schemas are missing', () => {
    expect(getMergedInputSchema(fakeTool({}))).toBeUndefined()
  })

  it('returns bodySchema directly when no paramsSchema', () => {
    const body = Type.Object({ name: Type.String() })
    expect(getMergedInputSchema(fakeTool({ bodySchema: body }))).toBe(body)
  })

  it('returns paramsSchema directly when no bodySchema', () => {
    const params = Type.Object({ id: Type.String() })
    expect(getMergedInputSchema(fakeTool({ paramsSchema: params }))).toBe(params)
  })

  it('merges body + path params into a single schema with all properties', () => {
    const merged = merge(
      Type.Object({ name: Type.String(), email: Type.Optional(Type.String()) }),
      Type.Object({ userId: Type.String() }),
    )
    expect(Object.keys(schemaProperties(merged)).sort()).toEqual(['email', 'name', 'userId'])
  })

  it('REGRESSION: merged schema preserves TypeBox [Kind] symbol', () => {
    const merged = merge(Type.Object({ description: Type.Optional(Type.String()) }), Type.Object({ roleName: Type.String() }))
    expect(typeboxKind(merged)).toBe('Object')
  })

  it('REGRESSION: merged property schemas preserve [Kind] symbols', () => {
    const merged = merge(
      Type.Object({
        name: Type.String(),
        count: Type.Optional(Type.Number()),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({ id: Type.String() }),
    )
    expect(Object.values(schemaProperties(merged)).map(typeboxKind)).toEqual(['String', 'Number', 'Array', 'String'])
  })

  it('REGRESSION: Value.Check does NOT throw "Unknown type" on merged schema', () => {
    const merged = merge(
      Type.Object({
        description: Type.Optional(Type.String()),
        fhirScopes: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({ roleName: Type.String() }),
    )
    expect(() => Value.Check(merged, { roleName: 'test-role', description: 'updated' })).not.toThrow()
  })

  it('REGRESSION: Value.Check validates correctly on merged schema', () => {
    const merged = merge(
      Type.Object({ name: Type.String(), enabled: Type.Optional(Type.Boolean()) }),
      Type.Object({ clientId: Type.String() }),
    )

    expect(Value.Check(merged, { clientId: 'app-1', name: 'My App' })).toBe(true)
    expect(Value.Check(merged, { clientId: 'app-1', name: 'My App', enabled: false })).toBe(true)
    expect(Value.Check(merged, { clientId: 'app-1' })).toBe(false)
    expect(Value.Check(merged, { clientId: 'app-1', name: 'X', enabled: 'yes' })).toBe(false)
  })

  it('merges required fields from both schemas', () => {
    const merged = merge(Type.Object({ name: Type.String() }), Type.Object({ id: Type.String() }))
    expect(schemaRequired(merged).sort()).toEqual(['id', 'name'])
  })

  it('path params override body properties with the same name', () => {
    const merged = merge(Type.Object({ id: Type.Number(), name: Type.String() }), Type.Object({ id: Type.String() }))
    expect(propertySchema(merged, 'id').type).toBe('string')
  })

  it('handles schemas with Union types (common in update routes)', () => {
    const merged = merge(
      Type.Object({
        status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('disabled')])),
        config: Type.Optional(Type.Object({ key: Type.String() })),
      }),
      Type.Object({ name: Type.String() }),
    )

    expect(Value.Check(merged, { name: 'test', status: 'active' })).toBe(true)
    expect(Value.Check(merged, { name: 'test', status: 'invalid' })).toBe(false)
  })

  it('handles all-optional body (PATCH semantics) with required path param', () => {
    const merged = merge(
      Type.Partial(Type.Object({
        displayName: Type.String(),
        enabled: Type.Boolean(),
        url: Type.String(),
      })),
      Type.Object({ serverId: Type.String() }),
    )

    expect(Value.Check(merged, { serverId: 'srv-1' })).toBe(true)
    expect(Value.Check(merged, { serverId: 'srv-1', displayName: 'Updated' })).toBe(true)
    expect(Value.Check(merged, { serverId: 'srv-1', enabled: true, url: 'https://x.com' })).toBe(true)
    expect(Value.Check(merged, { displayName: 'No ID' })).toBe(false)
  })
})
