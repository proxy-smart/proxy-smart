// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { TtlCache } from '../cache/ttl-cache'
import { getAdminClient } from '../kc-admin-factory'
import { logger } from '../logger'

/** The Keycloak Organization attribute naming the FHIR Organization it is. */
export const FHIR_ORGANIZATION_ATTRIBUTE = 'fhir_organization_id'

const MEMBERSHIP_TTL_MS = 60_000
const NO_ORGANIZATIONS: ReadonlySet<string> = new Set()
const memberships = new TtlCache<ReadonlySet<string>>({ ttlMs: MEMBERSHIP_TTL_MS, maxEntries: 10_000, cleanupIntervalMs: 60_000 })

async function loadMemberships(userId: string): Promise<ReadonlySet<string>> {
  const admin = await getAdminClient()
  if (!admin) return NO_ORGANIZATIONS
  const joined = await admin.organizations.memberOrganizations({ userId })
  const ids = joined.flatMap((org) => org.id ? [org.id] : [])
  const organizations = await Promise.all(ids.map((id) => admin.organizations.findOne({ id })))
  const fhirIds = organizations.flatMap((org) => org?.attributes?.[FHIR_ORGANIZATION_ATTRIBUTE] ?? [])
  return new Set(fhirIds.filter((id) => id !== ''))
}

/** The FHIR Organization ids of the Keycloak Organizations this user belongs to; none when Keycloak cannot say. */
export async function memberFhirOrganizations(userId: string | null): Promise<ReadonlySet<string>> {
  if (!userId) return NO_ORGANIZATIONS
  try {
    return await memberships.getOrLoad(userId, () => loadMemberships(userId))
  } catch (error) {
    logger.consent.warn('Organization membership lookup failed', { userId, error: error instanceof Error ? error.message : String(error) })
    return NO_ORGANIZATIONS
  }
}

export function invalidateOrganizationMemberships(userId?: string): void {
  if (userId) memberships.delete(userId)
  else memberships.clear()
}
