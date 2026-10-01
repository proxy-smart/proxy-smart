// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'
import { config } from '../config'
import { ConfigurationError } from './admin-utils'
import { logger } from './logger'

let cached: { uri: string; resolve: JWTVerifyGetKey } | null = null

/** Keycloak's signing keys, rebuilt when the realm is reconfigured at runtime. */
export function getJwksResolver(): JWTVerifyGetKey {
  const uri = config.keycloak.jwksUri
  if (!uri) {
    throw new ConfigurationError('Keycloak is not configured - cannot validate tokens')
  }
  if (cached?.uri !== uri) {
    cached = { uri, resolve: createRemoteJWKSet(new URL(uri)) }
    logger.auth.debug('JWKS resolver (re-)initialized', { jwksUri: uri })
  }
  return cached.resolve
}
