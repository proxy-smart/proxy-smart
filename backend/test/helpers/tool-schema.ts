// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Kind } from '@sinclair/typebox'
import type { ToolMetadata } from '../../src/lib/ai/tool-registry'
import { requireRecord, stringArray } from '../../src/lib/type-guards'

export function requireTool(tools: ReadonlyMap<string, ToolMetadata>, name: string): ToolMetadata {
  const tool = tools.get(name)
  if (!tool) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
  return tool
}

/** The `properties` of an object JSON/TypeBox schema; throws when the schema has none. */
export function schemaProperties(schema: unknown): Record<string, unknown> {
  return requireRecord(requireRecord(schema, 'schema').properties, 'schema.properties')
}

export function propertySchema(schema: unknown, name: string): Record<string, unknown> {
  return requireRecord(schemaProperties(schema)[name], `schema.properties.${name}`)
}

export function schemaRequired(schema: unknown): string[] {
  return stringArray(requireRecord(schema, 'schema').required) ?? []
}

/** The TypeBox kind a schema carries, which Value.Check needs to recognize it. */
export function typeboxKind(schema: unknown): unknown {
  return typeof schema === 'object' && schema !== null ? Reflect.get(schema, Kind) : undefined
}
