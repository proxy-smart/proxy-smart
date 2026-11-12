// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { requiredUserAttributes } from '../src/init/realm-settings'

const names = (extra: string[]) => requiredUserAttributes(extra).map((attribute) => attribute.name)

describe('requiredUserAttributes', () => {
  it('declares the attributes the configured deployment imports, after the proxy\'s own', () => {
    const own = names([])
    expect(own).toContain('fhirUser')
    expect(names(['department', 'cost_center'])).toEqual([...own, 'department', 'cost_center'])
  })

  it('declares a name once, and never redeclares one of the proxy\'s own', () => {
    expect(names(['department', 'department', 'fhirUser'])).toEqual([...names([]), 'department'])
  })
})
