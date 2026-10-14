// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import type OrganizationIdentityProviderLinkRepresentation from '@keycloak/keycloak-admin-client/lib/defs/organizationIdentityProviderLinkRepresentation.js'

/**
 * Brokered users always join a linked organization. Keycloak lets one organization per provider
 * manage them, so a provider's only organization keeps the pre-26.8 MANAGED membership and a shared
 * provider joins users as UNMANAGED members.
 */
function autoJoinLink(organizationId: string, soleOrganization: boolean): OrganizationIdentityProviderLinkRepresentation {
  return { organizationId, autoMembership: true, membershipType: soleOrganization ? 'MANAGED' : 'UNMANAGED' }
}

export interface OrganizationLinkRequest {
  organizationIds?: string[]
  organizationId?: string
}

export interface OrganizationLinkChanges {
  linked: string[]
  unlinked: string[]
}

/** Organizations the provider is linked to, as far as the caller may see them. */
export function linkedOrganizationIds(provider: IdentityProviderRepresentation): string[] {
  const linked = (provider.organizationLinks ?? [])
    .map((link) => link.organizationId)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (linked.length > 0) return linked
  return provider.organizationId ? [provider.organizationId] : []
}

/** The links a request asks for, or undefined when it leaves them alone. `organizationIds` wins. */
export function requestedOrganizationIds(request: OrganizationLinkRequest): string[] | undefined {
  const requested = request.organizationIds
    ?? (request.organizationId === undefined ? undefined : [request.organizationId])
  if (requested === undefined) return undefined
  return [...new Set(requested.filter((id) => id !== ''))]
}

/** Organizations in `requested` that do not exist, so a create can refuse before writing anything. */
export async function unknownOrganizationIds(admin: KcAdminClient, requested: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    requested.map((orgId) => admin.organizations.findOne({ id: orgId }).catch(() => undefined)),
  )
  return requested.filter((_, index) => !found[index]?.id)
}

/**
 * Brings the provider's organization links to `desired`. Keycloak 26.8 manages these through the
 * organization endpoints only; `organizationId` on the provider representation is ignored on write.
 */
export async function syncOrganizationLinks(
  admin: KcAdminClient,
  alias: string,
  current: readonly string[],
  desired: readonly string[],
): Promise<OrganizationLinkChanges> {
  const linked = desired.filter((orgId) => !current.includes(orgId))
  const unlinked = current.filter((orgId) => !desired.includes(orgId))
  // Unlink first: a dropped organization may still hold the provider's one MANAGED link.
  for (const orgId of unlinked) {
    await admin.organizations.unLinkIdp({ orgId, alias })
  }
  for (const orgId of linked) {
    await admin.organizations.linkIdp({ orgId, alias })
    await admin.organizations.updateIdentityProviderLink({ orgId, alias }, autoJoinLink(orgId, desired.length === 1))
  }
  return { linked, unlinked }
}
