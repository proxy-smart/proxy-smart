// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ConsentCheckResultWithIal, ConsentConfig } from '../../src/lib/consent/types'

export function makeConsentConfig(overrides: Partial<ConsentConfig> = {}): ConsentConfig {
  return {
    enabled: true,
    mode: 'enforce',
    cacheTtl: 60_000,
    exemptClients: [],
    requiredForResourceTypes: [],
    exemptResourceTypes: [],
    appUrl: null,
    appClientId: null,
    ...overrides,
  }
}

/** A consent permit with IAL off, for the request it answers. */
export function consentPermit(serverName: string, resourcePath: string, method: string): ConsentCheckResultWithIal {
  return {
    decision: 'permit',
    consentId: null,
    reason: 'test permit',
    cached: false,
    checkDurationMs: 0,
    ialCheck: null,
    context: {
      patientId: null,
      clientId: 'test-client',
      resourceType: resourcePath.split('/')[0] || null,
      resourceId: resourcePath.split('/')[1] ?? null,
      method,
      resourcePath,
      serverName,
      scopes: [],
      fhirUser: null,
      userId: null,
      ialEnabled: false,
      ialMinimumLevel: 'level1',
      isSensitiveResource: false,
      assuranceLevel: null,
      assuranceLevelNumeric: null,
      patientLinkVerified: false,
      personId: null,
    },
  }
}
