// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readCimdStatus, type CimdPolicyAdmin } from '../../src/lib/cimd-policy'

/** A Keycloak admin whose realm has an enabled CIMD policy, or none at all. */
export function cimdAdmin(enabled: boolean): CimdPolicyAdmin {
  return {
    clientPolicies: {
      listProfiles: async () => ({
        profiles: enabled
          ? [{ name: 'cimd-profile', executors: [{ executor: 'client-id-metadata-document', configuration: { 'cimd-allow-permitted-domains': ['claude.ai'] } }] }]
          : [],
      }),
      listPolicies: async () => ({
        policies: enabled
          ? [{ name: 'cimd-policy', enabled: true, conditions: [{ condition: 'client-id-uri', configuration: {} }], profiles: ['cimd-profile'] }]
          : [],
      }),
      createProfiles: async () => {},
      updatePolicy: async () => {},
    },
  }
}

/** Make the proxy remember CIMD as active or inactive, the way the startup check does. */
export async function rememberCimd(enabled: boolean): Promise<void> {
  await readCimdStatus(cimdAdmin(enabled))
}
