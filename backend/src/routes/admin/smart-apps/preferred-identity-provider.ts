// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'

export type FindIdentityProvider = (alias: string) => Promise<IdentityProviderRepresentation | undefined>

/** Why `alias` cannot be an app's preferred identity provider, or null when it can. Empty clears it. */
export async function preferredIdentityProviderRejection(find: FindIdentityProvider, alias: string | undefined): Promise<string | null> {
  if (!alias) return null
  const provider = await find(alias).catch(() => undefined)
  if (!provider) return `No identity provider "${alias}" exists in this realm`
  if (provider.enabled === false) return `Identity provider "${alias}" is disabled`
  if (provider.linkOnly === true) return `Identity provider "${alias}" only links accounts, so it cannot sign anyone in`
  return null
}
