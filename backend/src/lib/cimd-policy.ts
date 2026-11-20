// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Which hosts may name a client by its Client ID Metadata Document. The proxy resolves the document and stands in
 * for the client towards Keycloak, so Keycloak's own CIMD policy, which refuses the proxy callback, is retired.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { hostMatchesDomain } from '@proxy-smart/guards'
import { configuredRealm, writeAttributeGroup } from './runtime-config'
import { isRecord, stringArray } from './type-guards'
import { getServiceAccountAdmin } from './service-account-admin'
import { logger } from './logger'

const CIMD_PREFIX = 'cimd.'
const TRUSTED_DOMAINS_ATTRIBUTE = `${CIMD_PREFIX}trusted_domains`
const KEYCLOAK_CIMD_CONDITION = 'client-id-uri'
const KEYCLOAK_CIMD_DOMAINS = 'client-id-uri-allow-permitted-domains'
const TRUSTED_DOMAINS_TTL_MS = 60_000

export interface CimdStatus {
  enabled: boolean
  trustedDomains: string[]
}

type RealmAdmin = Pick<KcAdminClient, 'realms'>

let cached: { domains: string[]; expiresAt: number } | undefined
type PolicyAdmin = { clientPolicies: Pick<KcAdminClient['clientPolicies'], 'listPolicies' | 'updatePolicy'> }

function parseDomains(raw: string): string[] {
  return [...new Set(raw.split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean))]
}

/** undefined when never configured, so a first start can adopt Keycloak's list. */
export async function readCimdTrustedDomains(admin: RealmAdmin): Promise<string[] | undefined> {
  const realm = await admin.realms.findOne({ realm: configuredRealm() })
  const raw = realm?.attributes?.[TRUSTED_DOMAINS_ATTRIBUTE]
  return typeof raw === 'string' ? parseDomains(raw) : undefined
}

export async function writeCimdTrustedDomains(admin: RealmAdmin, domains: readonly string[]): Promise<string[]> {
  const normalized = parseDomains(domains.join(','))
  await writeAttributeGroup(admin, CIMD_PREFIX, { [TRUSTED_DOMAINS_ATTRIBUTE]: normalized.join(',') })
  cached = undefined
  return normalized
}

export function cimdStatus(domains: readonly string[] | undefined): CimdStatus {
  return { enabled: (domains?.length ?? 0) > 0, trustedDomains: [...(domains ?? [])] }
}

export function isTrustedCimdHost(clientId: string, domains: readonly string[]): boolean {
  try {
    const { hostname } = new URL(clientId)
    return domains.some((domain) => hostMatchesDomain(hostname, domain))
  } catch {
    return false
  }
}

/** The configured domains, re-read at most once a minute; [] when Keycloak cannot be read, so CIMD fails closed. */
export async function trustedCimdDomains(): Promise<string[]> {
  if (cached && Date.now() < cached.expiresAt) return cached.domains
  try {
    const domains = (await readCimdTrustedDomains(await getServiceAccountAdmin())) ?? []
    cached = { domains, expiresAt: Date.now() + TRUSTED_DOMAINS_TTL_MS }
    return domains
  } catch (error) {
    logger.auth.warn('Could not read the CIMD trusted domains', { error })
    return []
  }
}

/** Disables every Keycloak CIMD policy; the domains they trusted, or null when none was active. */
export async function retireKeycloakCimdPolicy(admin: PolicyAdmin): Promise<string[] | null> {
  const policies = (await admin.clientPolicies.listPolicies({ includeGlobalPolicies: false })).policies ?? []
  const isCimd = (conditions: typeof policies[number]['conditions']) =>
    conditions?.some((condition) => condition.condition === KEYCLOAK_CIMD_CONDITION) ?? false
  const active = policies.filter((policy) => policy.enabled !== false && isCimd(policy.conditions))
  if (active.length === 0) return null

  const domains = active.flatMap((policy) =>
    (policy.conditions ?? []).flatMap((condition) => {
      const configuration = isRecord(condition.configuration) ? condition.configuration : {}
      return condition.condition === KEYCLOAK_CIMD_CONDITION ? stringArray(configuration[KEYCLOAK_CIMD_DOMAINS]) ?? [] : []
    }),
  )
  await admin.clientPolicies.updatePolicy({
    policies: policies.map((policy) => (active.includes(policy) ? { ...policy, enabled: false } : policy)),
  })
  return [...new Set(domains)]
}

/** Startup: hand CIMD from Keycloak to the proxy, keeping the domains an operator already trusted. */
export async function adoptKeycloakCimdPolicy(admin: RealmAdmin & PolicyAdmin): Promise<void> {
  const domains = await retireKeycloakCimdPolicy(admin)
  if (domains === null) return
  const configured = await readCimdTrustedDomains(admin)
  if (configured === undefined) await writeCimdTrustedDomains(admin, domains)
  logger.keycloak.info('Retired Keycloak CIMD policy; the proxy now stands in for CIMD clients', {
    trustedDomains: configured ?? domains,
  })
}
