// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { asset, safeUrl } from './url'

describe('safeUrl', () => {
  it.each([
    ['/apps/consent/', '/apps/consent/'],
    ['https://cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['http://cdn.example/logo.png', null],
    ['javascript:alert(1)', null],
    ['//evil.example/x', null],
    ['/\\evil.example/x', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(safeUrl(input)).toBe(expected)
  })
})

describe('asset', () => {
  it('appends the version as an encoded query', () => {
    expect(asset('/css/base.css', '1.0.0+abc')).toBe('/css/base.css?v=1.0.0%2Babc')
  })
})
