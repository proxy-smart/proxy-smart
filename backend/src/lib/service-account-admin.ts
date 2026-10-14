// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { getAdminClient } from './kc-admin-factory'

/** The admin client acting as the service account, for paths with no user: dynamic registration and its reaper. */
export async function getServiceAccountAdmin(): Promise<KcAdminClient> {
  const admin = await getAdminClient()
  if (!admin) throw new Error('Keycloak admin access needs KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET')
  return admin
}
