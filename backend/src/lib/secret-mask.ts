// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Keycloak's own mask for secrets in admin representations; our responses use the same one. */
export const MASKED_SECRET = '**********'

/** Keycloak hands a confidential client's secret to admins; responses only say that one is set. */
export function maskClientSecret<T extends { secret?: string }>(client: T): T {
  return client.secret ? { ...client, secret: MASKED_SECRET } : client
}

export function maskSecretFields(config: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, keys.includes(key) && value ? MASKED_SECRET : value]),
  )
}
