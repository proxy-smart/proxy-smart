#!/usr/bin/env bun
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
// Elysia emits bare $refs and OpenAPI 3.1 constructs in a 3.0.3 spec, which make openapi-generator-cli NPE.

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { isRecord, requireRecord } from '../src/lib/type-guards'

type JsonObject = Record<string, unknown>

const objectAt = (value: unknown, key: string): JsonObject | undefined => {
  if (!isRecord(value)) return undefined
  const child = value[key]
  return isRecord(child) ? child : undefined
}

const childObjects = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []

const OPENAPI_PATH = resolve(import.meta.dir, '../dist/openapi.json')

console.log('🔧 Sanitizing OpenAPI spec...')

const content = readFileSync(OPENAPI_PATH, 'utf-8')
const spec = requireRecord(JSON.parse(content), 'dist/openapi.json')

let changeCount = 0

function downgradeToOpenApi303(obj: JsonObject): void {
  if ('patternProperties' in obj) {
    const patterns = isRecord(obj.patternProperties) ? obj.patternProperties : {}
    const patternKeys = Object.keys(patterns)
    if (patternKeys.length > 0) {
      const schema = patterns[patternKeys[0]]
      obj.additionalProperties = schema
    } else {
      obj.additionalProperties = true
    }
    delete obj.patternProperties
    if (!obj.type) obj.type = 'object'
    changeCount++
  }

  if ('anyOf' in obj && Array.isArray(obj.anyOf)) {
    const anyOfArr: unknown[] = obj.anyOf
    const nullIndex = anyOfArr.findIndex((s) => isRecord(s) && s.type === 'null')
    if (nullIndex !== -1) {
      const nonNull = anyOfArr.filter((_, i) => i !== nullIndex)
      if (nonNull.length === 1) {
        const remaining = nonNull[0]
        delete obj.anyOf
        Object.assign(obj, remaining)
        obj.nullable = true
      } else if (nonNull.length > 1) {
        obj.anyOf = nonNull
        obj.nullable = true
      } else {
        delete obj.anyOf
        obj.nullable = true
      }
      changeCount++
    }
  }

  if (obj.type === 'null') {
    delete obj.type
    obj.nullable = true
    changeCount++
  }

  for (const val of Object.values(obj)) {
    for (const child of childObjects(val)) downgradeToOpenApi303(child)
  }
}

console.log('  Downgrading OpenAPI 3.1 constructs to 3.0.3 compatibility...')
downgradeToOpenApi303(spec)

if (typeof spec.openapi === 'string' && spec.openapi.startsWith('3.1.')) {
  spec.openapi = '3.0.3'
  changeCount++
  console.log('  ✓ Downgraded openapi version field to 3.0.3')
}

function fixRefs(obj: JsonObject): void {
  for (const key in obj) {
    const value = obj[key]
    if (key === '$ref' && typeof value === 'string') {
      const ref = value

      if (!ref.startsWith('#') && !ref.startsWith('http')) {
        const schemaName = ref
        const schemaExists = objectAt(spec.components, 'schemas')?.[schemaName]
        
        if (schemaExists) {
          obj[key] = `#/components/schemas/${ref}`
          changeCount++
          console.log(`  ✓ Fixed incomplete reference: "${ref}" -> "#/components/schemas/${ref}"`)
        } else {
          // Redirect responses (/authorize, /login, /logout) have no JSON body; the parent removes the schema.
          console.log(`  ⚠ Warning: Schema "${ref}" doesn't exist, will remove response schema`)
          obj._removeMe = true
          changeCount++
        }
      }
    } else if (isRecord(value) || Array.isArray(value)) {
      if (isRecord(value)) fixRefs(value)
      else for (const item of value) if (isRecord(item)) fixRefs(item)

      if (isRecord(value) && value._removeMe) {
        if (key === 'schema') {
          delete obj[key]
        }
      }
    }
  }
}

fixRefs(spec)

function cleanupEmptyResponses(obj: JsonObject): void {
  for (const key in obj) {
    const responses = objectAt(obj, key)
    if (key === 'responses' && responses) {
      for (const statusCode in responses) {
        const response = objectAt(responses, statusCode)
        if (response && isRecord(response.content)) {
          const jsonContent = objectAt(response.content, 'application/json')
          if (jsonContent && !jsonContent.schema) {
            delete response.content
            response.description = response.description || 'Redirect response'
            console.log(`  ✓ Removed empty content from response ${statusCode}`)
            changeCount++
          }
        }
      }
    }
    
    const nested = obj[key]
    if (isRecord(nested)) cleanupEmptyResponses(nested)
  }
}

cleanupEmptyResponses(spec)

// Routes with a custom `parse` get an empty requestBody content: https://github.com/elysiajs/elysia/issues/1825
const emptyRequestBodyFixes: Record<string, { title: string; schema: JsonObject }> = {
  '/auth/token': {
    title: 'TokenRequest',
    schema: {
      title: 'TokenRequest',
      type: 'object',
      required: ['grant_type'],
      properties: {
        grant_type: { type: 'string', description: 'OAuth2 grant type (authorization_code, refresh_token, client_credentials, password, urn:ietf:params:oauth:grant-type:token-exchange)' },
        code: { type: 'string', description: 'Authorization code (for authorization_code grant)', nullable: true },
        redirect_uri: { type: 'string', description: 'Redirect URI used in authorization request', nullable: true },
        client_id: { type: 'string', description: 'OAuth2 client ID', nullable: true },
        client_secret: { type: 'string', description: 'OAuth2 client secret', nullable: true },
        code_verifier: { type: 'string', description: 'PKCE code verifier', nullable: true },
        refresh_token: { type: 'string', description: 'Refresh token (for refresh_token grant)', nullable: true },
        scope: { type: 'string', description: 'Requested scopes (space-separated)', nullable: true },
        audience: { type: 'string', description: 'Target audience for the token', nullable: true },
        resource: { type: 'string', description: 'Target resource URI (RFC 8707 Resource Indicators)', nullable: true },
        username: { type: 'string', description: 'Username (for password grant)', nullable: true },
        password: { type: 'string', description: 'Password (for password grant)', nullable: true },
        client_assertion_type: { type: 'string', description: 'Client assertion type for JWT authentication', nullable: true },
        client_assertion: { type: 'string', description: 'Client assertion JWT for authentication', nullable: true },
        subject_token: { type: 'string', description: 'Security token to be exchanged (for token-exchange grant)', nullable: true },
        subject_token_type: { type: 'string', description: 'Type of subject_token (urn:ietf:params:oauth:token-type:access_token)', nullable: true },
        requested_token_type: { type: 'string', description: 'Type of requested token (urn:ietf:params:oauth:token-type:access_token)', nullable: true },
      }
    }
  }
}

if (spec.paths) {
  for (const [path, fix] of Object.entries(emptyRequestBodyFixes)) {
    const requestBody = objectAt(objectAt(objectAt(spec.paths, path), 'post'), 'requestBody')
    const content = objectAt(requestBody, 'content')
    if (requestBody && content && Object.keys(content).length === 0) {
      requestBody.content = {
        'application/x-www-form-urlencoded': { schema: fix.schema },
        'application/json': { schema: fix.schema },
      }
      console.log(`  ✓ Injected missing requestBody schema for POST ${path} (${fix.title})`)
      changeCount++
    }
  }
}

if (isRecord(spec.paths)) {
  for (const pathItem of Object.values(spec.paths)) {
    if (isRecord(pathItem) && 'ws' in pathItem) {
      delete pathItem.ws
      console.log(`  ✓ Removed WebSocket endpoint`)
      changeCount++
    }
  }
}

writeFileSync(OPENAPI_PATH, JSON.stringify(spec, null, 2))

if (changeCount > 0) {
  console.log(`✅ Sanitized OpenAPI spec: ${changeCount} changes made`)
} else {
  console.log('✅ OpenAPI spec is already valid, no changes needed')
}
