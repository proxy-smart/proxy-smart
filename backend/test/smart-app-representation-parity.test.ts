// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'

const attributesOf = (representation: { attributes?: Record<string, unknown> }) =>
  new Map(Object.entries(representation.attributes ?? {}))

const existing = { clientId: 'app', publicClient: true, standardFlowEnabled: true, redirectUris: ['https://app.example.com/cb'], attributes: {} }

describe('create and update write the same attributes', () => {
  const fields = {
    scopeSetId: 'clinician-read',
    serverAccessType: 'specific' as const,
    allowedServerIds: ['hapi'],
    organizationIds: ['org-1'],
    launchUrl: 'https://app.example.com/launch',
    logoUri: 'https://app.example.com/logo.png',
    tosUri: 'https://app.example.com/tos',
    policyUri: 'https://app.example.com/privacy',
    allowedFhirUserTypes: ['Practitioner'],
    requiredRoles: ['clinician'],
  }

  it.each(Object.entries(fields))('%s', (field, value) => {
    const { representation } = buildCreatePlan({ clientId: 'app', name: 'App', redirectUris: existing.redirectUris, [field]: value })
    const created = attributesOf(representation)
    const updated = attributesOf(buildUpdateRepresentation({ [field]: value }, existing))
    const written = [...created.keys()].filter((key) => !attributesOf(buildCreatePlan({ clientId: 'app', name: 'App', redirectUris: existing.redirectUris }).representation).has(key))
    expect(written.length).toBeGreaterThan(0)
    for (const key of written) expect(updated.get(key)).toBe(created.get(key))
  })
})
