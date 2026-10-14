// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { AccessControlContext } from '../../src/lib/smart-access-control'
import { applyEnv } from './test-env'

export function clearAccessControlModes(): void {
  applyEnv({ SCOPE_ENFORCEMENT_MODE: undefined, ROLE_BASED_FILTERING_MODE: undefined })
}

export function makeAccessContext(overrides: Partial<AccessControlContext> = {}): AccessControlContext {
  return {
    tokenPayload: { scope: 'openid' },
    resourcePath: 'Patient',
    method: 'GET',
    serverUrl: 'https://fhir.example.com',
    serverId: 'test-server',
    serverName: 'test-fhir',
    authHeader: 'Bearer t',
    upstreamFetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    ...overrides,
  }
}
