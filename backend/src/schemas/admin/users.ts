// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { AttributesMap } from './common'
import { OrganizationMembership } from './organizations'

export const FederatedIdentity = t.Object({
  identityProvider: t.String({ description: 'Identity provider alias' }),
  userId: t.String({ description: 'User ID at the identity provider' }),
  userName: t.String({ description: 'Username at the identity provider' })
}, { title: 'FederatedIdentity' })

/** Not `userId`: that is already a path param, and the MCP tool surface flattens path and body into one. */
export const LinkFederatedIdentityRequest = t.Object({
  providerUserId: t.String({ description: "Subject (`sub`) this user has AT the identity provider" }),
  providerUserName: t.String({ description: 'Username at the identity provider' })
}, { title: 'LinkFederatedIdentityRequest' })

export const FhirPersonAssociation = t.Object({
  serverId: t.String({ description: 'FHIR server identifier' }),
  personId: t.String({ description: 'FHIR Person resource ID' }),
  display: t.Optional(t.String({ description: 'Display name for the Person' })),
  created: t.Optional(t.String({ description: 'Creation timestamp (ISO 8601)' }))
}, { title: 'FhirPersonAssociation' })

export const HealthcareUser = t.Object({
  id: t.String({ description: 'User ID' }),
  username: t.String({ description: 'Username' }),
  email: t.String({ description: 'Email address' }),
  firstName: t.String({ description: 'First name' }),
  lastName: t.String({ description: 'Last name' }),
  enabled: t.Boolean({ description: 'Whether the user is enabled' }),
  attributes: t.Optional(AttributesMap),
  createdTimestamp: t.Optional(t.Number({ description: 'Creation timestamp (Unix milliseconds)' })),
  lastLogin: t.Optional(t.Union([t.Number(), t.Null()], { description: 'Last login timestamp' })),
  realmRoles: t.Optional(t.Array(t.String(), { description: 'Realm-level roles' })),
  clientRoles: t.Optional(t.Record(t.String(), t.Array(t.String()))),
  organization: t.Optional(t.String({ description: 'Organization user attribute, imported from the identity provider; not Keycloak Organization membership' })),
  organizations: t.Optional(t.Array(OrganizationMembership, { description: 'Keycloak Organizations the user is a member of' })),
  fhirPersons: t.Optional(t.Array(FhirPersonAssociation, { description: 'FHIR Person associations across different servers' })),
  emailVerified: t.Optional(t.Boolean({ description: 'Whether the email is verified' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR User identity reference (e.g. Patient/123 or Practitioner/456)' })),
  federatedIdentities: t.Optional(t.Array(FederatedIdentity, { description: 'Linked identity provider accounts' }))
}, { title: 'HealthcareUser' })

export const CreateHealthcareUserRequest = t.Object({
  username: t.String({ description: 'Username (must be unique)' }),
  email: t.String({ format: 'email', description: 'Email address' }),
  firstName: t.String({ description: 'First name' }),
  lastName: t.String({ description: 'Last name' }),
  organization: t.Optional(t.String({ description: 'Organization identifier' })),
  fhirPersons: t.Optional(t.Array(FhirPersonAssociation, { description: 'FHIR Person associations to create' })),
  password: t.Optional(t.String({ description: 'User password' })),
  temporaryPassword: t.Optional(t.Boolean({ description: 'Whether password is temporary and must be changed' })),
  realmRoles: t.Optional(t.Array(t.String(), { description: 'Realm-level roles to assign' })),
  clientRoles: t.Optional(t.Record(t.String(), t.Array(t.String()))),
  enabled: t.Optional(t.Boolean({ description: 'Whether the user is enabled', default: true })),
  emailVerified: t.Optional(t.Boolean({ description: 'Whether the email is verified' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR User identity reference (e.g. Patient/123 or Practitioner/456)' }))
}, { title: 'CreateHealthcareUserRequest' })

export const UpdateHealthcareUserRequest = t.Object({
  firstName: t.Optional(t.String({ description: 'First name' })),
  lastName: t.Optional(t.String({ description: 'Last name' })),
  email: t.Optional(t.String({ format: 'email', description: 'Email address' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether the user is enabled' })),
  organization: t.Optional(t.String({ description: 'Organization identifier' })),
  fhirPersons: t.Optional(t.Array(FhirPersonAssociation, { description: 'FHIR Person associations to update' })),
  realmRoles: t.Optional(t.Array(t.String(), { description: 'Realm-level roles' })),
  clientRoles: t.Optional(t.Record(t.String(), t.Array(t.String()))),
  password: t.Optional(t.String({ description: 'New password (resets the user password)' })),
  temporaryPassword: t.Optional(t.Boolean({ description: 'Whether password is temporary and must be changed on next login' })),
  credentials: t.Optional(t.Array(t.Object({
    type: t.String({ description: 'Credential type (e.g. "password")' }),
    value: t.String({ description: 'Credential value' }),
    temporary: t.Optional(t.Boolean({ description: 'Whether credential is temporary' }))
  }), { description: 'Credentials array (alternative to password field)' })),
  emailVerified: t.Optional(t.Boolean({ description: 'Whether the email is verified' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR User identity reference (e.g. Patient/123 or Practitioner/456)' }))
}, { title: 'UpdateHealthcareUserRequest' })

export const UserIdParam = t.Object({
  userId: t.String({ description: 'User ID' })
}, { title: 'UserIdParam' })

export type FhirPersonAssociationType = Static<typeof FhirPersonAssociation>
export type FederatedIdentityType = Static<typeof FederatedIdentity>
export type LinkFederatedIdentityRequestType = Static<typeof LinkFederatedIdentityRequest>
export type HealthcareUserType = Static<typeof HealthcareUser>
export type CreateHealthcareUserRequestType = Static<typeof CreateHealthcareUserRequest>
export type UpdateHealthcareUserRequestType = Static<typeof UpdateHealthcareUserRequest>
