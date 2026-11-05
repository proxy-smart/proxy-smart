// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { KeycloakAdapter } from '@proxy-smart/auth'
import { keycloakAdapter } from '@/routes/auth/smart-proxy-setup'

describe('the backend Keycloak adapter', () => {
  it('forwards every method KeycloakAdapter offers, since a missing optional one is skipped silently', () => {
    const offered = Object.getOwnPropertyNames(KeycloakAdapter.prototype).filter((name) => name !== 'constructor')
    expect(Object.keys(keycloakAdapter).sort()).toEqual(offered.sort())
  })

  it('sends a preferred identity provider as kc_idp_hint', () => {
    expect(keycloakAdapter.getIdentityProviderHintParams?.('maxhealth')).toEqual({ kc_idp_hint: 'maxhealth' })
  })
})
