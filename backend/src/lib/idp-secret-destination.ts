// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isOAuth2Broker } from './idp-required-config'
import { MASKED_SECRET } from './secret-mask'

type ConfigMap = Record<string, unknown>

/** How a destination key's stored and submitted values compare, mirroring Keycloak's runtime defaults. */
type Normalize = (value: string | undefined) => string | undefined

const blankAsUnset: Normalize = (value) => (value === '' ? undefined : value)

const BASE_DESTINATION_KEYS: Readonly<Record<string, Normalize>> = {
  tokenUrl: blankAsUnset,
  tokenIntrospectionUrl: blankAsUnset,
  clientId: blankAsUnset,
  baseUrl: blankAsUnset,
  clientAuthMethod: (value) => blankAsUnset(value) ?? 'client_secret_post',
}

const PROVIDER_DESTINATION_KEYS: Readonly<Record<string, Readonly<Record<string, Normalize>>>> = {
  microsoft: { tenantId: (value) => blankAsUnset(value)?.trim() ?? 'common' },
  paypal: { sandbox: (value) => String(value?.toLowerCase() === 'true') },
}

function configString(config: ConfigMap, key: string): string | undefined {
  const value = config[key]
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * The config keys that changed where or how the client secret is sent while the submitted secret
 * is still the mask. Keycloak 26.8 rejects such an update with 400 (CVE-2026-15943), so the
 * caller has to re-enter the secret.
 */
export function maskedSecretDestinationChanges(
  providerId: string | undefined,
  stored: ConfigMap,
  submitted: ConfigMap,
): string[] {
  if (!providerId || !isOAuth2Broker(providerId)) return []
  if (configString(submitted, 'clientSecret') !== MASKED_SECRET) return []
  const keys = { ...BASE_DESTINATION_KEYS, ...PROVIDER_DESTINATION_KEYS[providerId] }
  return Object.entries(keys)
    .filter(([key, normalize]) => normalize(configString(stored, key)) !== normalize(configString(submitted, key)))
    .map(([key]) => key)
}
