// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { decodeJwt, type JWTPayload } from 'jose'

/** A JWT's claims WITHOUT verifying it, for bookkeeping keyed on a token Keycloak has already judged. Null when opaque. */
export function readUnverifiedClaims(token: string): JWTPayload | null {
  try {
    return decodeJwt(token)
  } catch {
    return null
  }
}
