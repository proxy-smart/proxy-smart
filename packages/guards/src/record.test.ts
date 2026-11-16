// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, test } from 'bun:test'
import { isRecord, parseJson, parseJsonRecord, requireRecord, stringEntries } from './record'

describe('isRecord', () => {
  test('holds for plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
    for (const value of [null, undefined, [], [1], 'x', 0, true, () => {}]) expect(isRecord(value)).toBe(false)
  })
})

describe('requireRecord', () => {
  test('returns the object and throws naming the value otherwise', () => {
    const value = { a: 1 }
    expect(requireRecord(value, 'body')).toBe(value)
    expect(() => requireRecord([], 'body')).toThrow('body')
    expect(() => requireRecord(null, 'config')).toThrow('config')
  })
})

describe('stringEntries', () => {
  test('keeps string values and drops the rest', () => {
    expect(stringEntries({ a: 'x', b: 1, c: null, d: ['y'], e: 'z' })).toEqual({ a: 'x', e: 'z' })
    expect(stringEntries('nope')).toEqual({})
    expect(stringEntries([['a', 'b']])).toEqual({})
  })
})

describe('parseJson', () => {
  test('parses JSON and yields undefined for absent or malformed text', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson('[1]')).toEqual([1])
    expect(parseJson('null')).toBeNull()
    expect(parseJson('')).toBeUndefined()
    expect(parseJson(undefined)).toBeUndefined()
    expect(parseJson('{oops')).toBeUndefined()
  })

  test('parseJsonRecord returns only objects', () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonRecord('[1]')).toBeNull()
    expect(parseJsonRecord('"x"')).toBeNull()
    expect(parseJsonRecord('{oops')).toBeNull()
    expect(parseJsonRecord(undefined)).toBeNull()
  })
})
