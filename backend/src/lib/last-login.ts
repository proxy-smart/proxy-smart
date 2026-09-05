// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Record when a user last logged in.
 *
 * Keycloak stores no last-login on the user: the only first-class record is a LOGIN event,
 * and events are off by default (and retaining per-user access logs on a health IdP is a
 * retention decision, not a code one). So it is kept as a user attribute — `lastLogin` is
 * already declared on the realm's user profile for exactly this, which matters because
 * Keycloak 26 silently drops attributes the profile does not declare.
 *
 * Written on the authorization_code grant only. A refresh is not a login, and writing there
 * would move the value every time a token aged out rather than when the person actually
 * signed in.
 */

import { getAdminClient } from './kc-admin-factory'
import { setUserAttribute } from './admin-utils'
import { logger } from './logger'

/**
 * Stamp `lastLogin` on a user, best-effort.
 *
 * Never throws and is not awaited by the token endpoint: a failure here must not fail, or
 * delay, a sign-in that Keycloak has already granted.
 */
export async function recordLastLogin(userId: string): Promise<void> {
  try {
    const admin = await getAdminClient()
    if (!admin) return
    await setUserAttribute(admin, userId, 'lastLogin', String(Date.now()))
  } catch (error) {
    logger.auth.warn('Could not record last login', { userId, error })
  }
}
