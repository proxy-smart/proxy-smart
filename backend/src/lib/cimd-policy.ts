// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The Keycloak client profile + policy that make CIMD (OAuth Client ID Metadata Document) work,
 * and whether they are active. Keycloak's `cimd` feature alone accepts no URL client_id: without
 * a policy naming the client's domain it answers "Client not found". Discovery does not
 * advertise CIMD (see buildAuthorizationServerMetadata); this backs the admin status/configure API.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { isRecord } from './type-guards'

const CIMD_EXECUTOR_ID = 'client-id-metadata-document'
const CIMD_CONDITION_ID = 'client-id-uri'
export const DEFAULT_CIMD_PROFILE_NAME = 'cimd-profile'
export const DEFAULT_CIMD_POLICY_NAME = 'cimd-policy'

export interface CimdSetup {
  trustedDomains: string[]
  allowHttpScheme?: boolean
  restrictSameDomain?: boolean
  onlyConfidentialClients?: boolean
  uriSchemes?: string[]
  profileName?: string
  policyName?: string
}

export interface CimdStatus {
  enabled: boolean
  profileName?: string
  policyName?: string
  trustedDomains?: string[]
  executorConfig?: Record<string, unknown>
}

/** The slice of the Keycloak admin client the CIMD policy needs. */
export interface CimdPolicyAdmin {
  clientPolicies: Pick<KcAdminClient['clientPolicies'], 'listProfiles' | 'listPolicies' | 'createProfiles' | 'updatePolicy'>
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

export async function readCimdStatus(admin: CimdPolicyAdmin): Promise<CimdStatus> {
  const profiles = await admin.clientPolicies.listProfiles({ includeGlobalProfiles: false })
  const cimdProfile = (profiles.profiles || []).find(p => p.executors?.some(e => e.executor === CIMD_EXECUTOR_ID))
  const policies = await admin.clientPolicies.listPolicies({ includeGlobalPolicies: false })
  const cimdPolicy = (policies.policies || []).find(p => p.conditions?.some(c => c.condition === CIMD_CONDITION_ID))

  if (!cimdProfile && !cimdPolicy) return { enabled: false }

  const executorConfig = cimdProfile?.executors?.find(e => e.executor === CIMD_EXECUTOR_ID)?.configuration
  const conditionConfig = cimdPolicy?.conditions?.find(c => c.condition === CIMD_CONDITION_ID)?.configuration
  const executorRecord = isRecord(executorConfig) ? executorConfig : undefined
  const conditionRecord = isRecord(conditionConfig) ? conditionConfig : undefined

  return {
    enabled: (cimdPolicy?.enabled ?? false) && !!cimdProfile,
    profileName: cimdProfile?.name,
    policyName: cimdPolicy?.name,
    trustedDomains:
      stringList(executorRecord?.['cimd-allow-permitted-domains'])
      ?? stringList(conditionRecord?.['client-id-uri-allow-permitted-domains'])
      ?? [],
    executorConfig: executorRecord,
  }
}

/** Create or replace the CIMD profile and policy (matched by name), and enable the policy. */
export async function applyCimdPolicy(
  admin: CimdPolicyAdmin,
  setup: CimdSetup,
): Promise<{ profileName: string; policyName: string }> {
  const profileName = setup.profileName || DEFAULT_CIMD_PROFILE_NAME
  const policyName = setup.policyName || DEFAULT_CIMD_POLICY_NAME

  const profiles = (await admin.clientPolicies.listProfiles({ includeGlobalProfiles: false })).profiles || []
  const profile = {
    name: profileName,
    description: 'OAuth Client ID Metadata Document (CIMD) profile for MCP clients',
    executors: [{
      executor: CIMD_EXECUTOR_ID,
      configuration: {
        'cimd-allow-http-scheme': setup.allowHttpScheme ?? false,
        'cimd-allow-permitted-domains': setup.trustedDomains,
        'cimd-restrict-same-domain': setup.restrictSameDomain ?? false,
        'only-allow-confidential-client': setup.onlyConfidentialClients ?? false,
      },
    }],
  }
  const profileIdx = profiles.findIndex(p => p.name === profileName)
  if (profileIdx >= 0) profiles[profileIdx] = profile
  else profiles.push(profile)
  await admin.clientPolicies.createProfiles({ profiles })

  const policies = (await admin.clientPolicies.listPolicies({ includeGlobalPolicies: false })).policies || []
  const policy = {
    name: policyName,
    description: 'Triggers CIMD processing when client_id is a URL matching trusted domains',
    enabled: true,
    conditions: [{
      condition: CIMD_CONDITION_ID,
      configuration: {
        'client-id-uri-scheme': setup.uriSchemes || ['https'],
        'client-id-uri-allow-permitted-domains': setup.trustedDomains,
      },
    }],
    profiles: [profileName],
  }
  const policyIdx = policies.findIndex(p => p.name === policyName)
  if (policyIdx >= 0) policies[policyIdx] = policy
  else policies.push(policy)
  await admin.clientPolicies.updatePolicy({ policies })

  return { profileName, policyName }
}
