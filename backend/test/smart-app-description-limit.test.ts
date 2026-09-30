// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { CreateSmartAppRequest, UpdateSmartAppRequest } from '../src/schemas/admin/smart-apps'

const base = { clientId: 'max-health-scribe', name: 'Max Health Scribe' }

describe('SMART app description', () => {
  it('accepts what Keycloak can store', () => {
    expect(Value.Check(CreateSmartAppRequest, { ...base, description: 'x'.repeat(255) })).toBe(true)
  })

  it('refuses a description Keycloak would answer with unknown_error', () => {
    expect(Value.Check(CreateSmartAppRequest, { ...base, description: 'x'.repeat(256) })).toBe(false)
    expect(Value.Check(UpdateSmartAppRequest, { description: 'x'.repeat(256) })).toBe(false)
  })
})
