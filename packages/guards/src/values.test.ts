// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, test } from 'bun:test'
import { isOneOf, isStringArray, optionalNumber, optionalString, stringArray, stringList } from './values'

describe('optional scalars', () => {
  test('optionalString keeps strings, including empty ones', () => {
    expect(optionalString('a')).toBe('a')
    expect(optionalString('')).toBe('')
    expect(optionalString(1)).toBeUndefined()
    expect(optionalString(null)).toBeUndefined()
  })

  test('optionalNumber keeps numbers only', () => {
    expect(optionalNumber(0)).toBe(0)
    expect(optionalNumber(1.5)).toBe(1.5)
    expect(optionalNumber('1')).toBeUndefined()
    expect(optionalNumber(undefined)).toBeUndefined()
  })
})

describe('string arrays', () => {
  test('isStringArray requires every item to be a string', () => {
    expect(isStringArray([])).toBe(true)
    expect(isStringArray(['a', 'b'])).toBe(true)
    expect(isStringArray(['a', 1])).toBe(false)
    expect(isStringArray('a')).toBe(false)
  })

  test('stringArray filters items and rejects non-arrays', () => {
    expect(stringArray(['a', 1, 'b', null])).toEqual(['a', 'b'])
    expect(stringArray([])).toEqual([])
    expect(stringArray('a')).toBeUndefined()
    expect(stringArray({ 0: 'a' })).toBeUndefined()
  })

  test('stringList accepts one string or a list', () => {
    expect(stringList('a')).toEqual(['a'])
    expect(stringList(['a', 2, 'b'])).toEqual(['a', 'b'])
    expect(stringList(undefined)).toEqual([])
    expect(stringList(3)).toEqual([])
  })
})

describe('isOneOf', () => {
  const COLOURS = ['red', 'green'] as const

  test('narrows to the listed literals', () => {
    const value: unknown = 'red'
    if (!isOneOf(COLOURS, value)) throw new Error('expected a colour')
    const colour: 'red' | 'green' = value
    expect(colour).toBe('red')
  })

  test('rejects anything not listed', () => {
    expect(isOneOf(COLOURS, 'blue')).toBe(false)
    expect(isOneOf(COLOURS, 'RED')).toBe(false)
    expect(isOneOf(COLOURS, undefined)).toBe(false)
    expect(isOneOf([], 'red')).toBe(false)
  })
})
