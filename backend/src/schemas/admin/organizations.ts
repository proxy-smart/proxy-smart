// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * Keycloak Organization schemas for admin API
 */

/** A single internet domain belonging to an organization */
export const OrganizationDomain = t.Object({
  name: t.Optional(t.String({ description: 'Domain name (e.g. acme.com)' })),
  verified: t.Optional(t.Boolean({ description: 'Whether the domain has been verified' }))
}, { title: 'OrganizationDomain' })

/** Full Keycloak Organization representation */
export const Organization = t.Object({
  id: t.Optional(t.String({ description: 'Keycloak organization ID (UUID)' })),
  name: t.Optional(t.String({ description: 'Organization display name (unique within realm)' })),
  alias: t.Optional(t.String({ description: 'URL-friendly alias (immutable after creation)' })),
  description: t.Optional(t.String({ description: 'Free-text description' })),
  redirectUrl: t.Optional(t.String({ description: 'Redirect URL after registration/invitation' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether the organization is enabled' })),
  attributes: t.Optional(t.Record(t.String(), t.Array(t.String()), {
    description: 'Arbitrary key→value[] metadata (includes fhir_organization_id for sync)'
  })),
  domains: t.Optional(t.Array(OrganizationDomain, {
    description: 'Email domains owned by this organization'
  }))
}, { title: 'Organization' })

/** An organization a user is a member of */
export const OrganizationMembership = t.Object({
  id: t.String({ description: 'Keycloak organization ID (UUID)' }),
  name: t.String({ description: 'Organization display name' }),
  alias: t.Optional(t.String({ description: 'URL-friendly alias' }))
}, { title: 'OrganizationMembership' })

/** Request body for creating a new organization */
export const CreateOrganizationRequest = t.Object({
  name: t.String({ description: 'Organization display name (required, unique)' }),
  alias: t.Optional(t.String({ description: 'URL-friendly alias (auto-derived from name if omitted)' })),
  description: t.Optional(t.String({ description: 'Free-text description' })),
  redirectUrl: t.Optional(t.String({ description: 'Post-registration redirect URL' })),
  enabled: t.Optional(t.Boolean({ description: 'Enabled state (defaults to true)', default: true })),
  attributes: t.Optional(t.Record(t.String(), t.Array(t.String()))),
  domains: t.Optional(t.Array(OrganizationDomain))
}, { title: 'CreateOrganizationRequest' })

/** Request body for updating an organization */
export const UpdateOrganizationRequest = t.Object({
  name: t.Optional(t.String({ description: 'Organization display name' })),
  description: t.Optional(t.String({ description: 'Free-text description' })),
  redirectUrl: t.Optional(t.String({ description: 'Post-registration redirect URL' })),
  enabled: t.Optional(t.Boolean({ description: 'Enabled state' })),
  attributes: t.Optional(t.Record(t.String(), t.Array(t.String()))),
  domains: t.Optional(t.Array(OrganizationDomain))
}, { title: 'UpdateOrganizationRequest' })

/** Path parameter for org-level routes */
export const OrgIdParam = t.Object({
  orgId: t.String({ description: 'Keycloak organization ID' })
}, { title: 'OrgIdParam' })

/** Organization member (lightweight) */
export const OrganizationMember = t.Object({
  id: t.Optional(t.String()),
  username: t.Optional(t.String()),
  email: t.Optional(t.String()),
  firstName: t.Optional(t.String()),
  lastName: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  membershipType: t.Optional(t.String({ description: 'MANAGED or UNMANAGED' }))
}, { title: 'OrganizationMember' })

/** Request to add a member */
export const AddMemberRequest = t.Object({
  userId: t.String({ description: 'Keycloak user ID to add as member' })
}, { title: 'AddMemberRequest' })

// TS type helpers
export type OrganizationType = Static<typeof Organization>
export type CreateOrganizationRequestType = Static<typeof CreateOrganizationRequest>
export type UpdateOrganizationRequestType = Static<typeof UpdateOrganizationRequest>
export type OrganizationMemberType = Static<typeof OrganizationMember>
export type OrganizationMembershipType = Static<typeof OrganizationMembership>
