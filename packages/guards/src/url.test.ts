// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { expect, test } from 'bun:test'
import { isHttpUrl } from './url'

test('isHttpUrl accepts absolute http and https URLs only', () => {
  expect(isHttpUrl('https://example.org/logo.png')).toBe(true)
  expect(isHttpUrl('HTTP://example.org')).toBe(true)
  const rejected = ['', 'clipboard-list', '/logo.png', '//example.org/x', 'ftp://example.org', 'javascript:alert(1)', 'https://', 'data:image/png;base64,AA', 42, null, undefined]
  for (const value of rejected) expect(isHttpUrl(value)).toBe(false)
})
