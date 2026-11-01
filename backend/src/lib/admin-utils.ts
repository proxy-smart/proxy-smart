// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KeycloakAdminClient from '@keycloak/keycloak-admin-client'
import type UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation.js'
import { parseFhirPersons } from './fhir-person-associations'
import type { AdminAccess } from './admin-roles'

type KeycloakUser = UserRepresentation

export function extractBearerToken(headers: Record<string, string | undefined>): string | null {
  const authorization = headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    return null
  }
  return authorization.replace('Bearer ', '')
}

export const UNAUTHORIZED_RESPONSE = {
  error: 'Authorization header required'
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Authentic, correctly audienced token whose roles lack admin access (vs AuthenticationError). */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AdminRequestContext {
  getAdmin: (token: string, access?: AdminAccess) => Promise<KeycloakAdminClient>
  headers: Record<string, string | undefined>
}

/** Bearer token or AuthenticationError, which handleAdminError answers with 401. */
export function requireBearerToken(headers: Record<string, string | undefined>): string {
  const token = extractBearerToken(headers)
  if (!token) throw new AuthenticationError(UNAUTHORIZED_RESPONSE.error)
  return token
}

export async function requireAdminClient(
  { getAdmin, headers }: AdminRequestContext,
  access?: AdminAccess
): Promise<KeycloakAdminClient> {
  return getAdmin(requireBearerToken(headers), access)
}

export function mapHealthcareUser(user: KeycloakUser) {
  const fhirPersons = parseFhirPersons(user.attributes?.fhir_persons?.[0])

  return {
    id: user.id ?? '',
    username: user.username ?? '',
    email: user.email ?? '',
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    enabled: user.enabled ?? false,
    attributes: user.attributes ?? {},
    createdTimestamp: user.createdTimestamp ?? 0,
    lastLogin: user.attributes?.lastLogin?.[0] ? Number(user.attributes.lastLogin[0]) : null,
    organization: user.attributes?.organization?.[0],
    fhirPersons,
    emailVerified: user.emailVerified,
    fhirUser: user.attributes?.fhirUser?.[0]
  }
}

/** Null removes the attribute; legacyAttributeName is written alongside for backwards compatibility. */
export async function setUserAttribute(
  admin: KeycloakAdminClient,
  userId: string,
  attributeName: string,
  value: string | boolean | null,
  legacyAttributeName?: string
): Promise<void> {
  const user = await admin.users.findOne({ id: userId })
  if (!user) {
    throw new Error('User not found')
  }

  const attributes = user.attributes || {}
  
  if (value === null || value === undefined) {
    delete attributes[attributeName]
    if (legacyAttributeName) {
      delete attributes[legacyAttributeName]
    }
  } else {
    attributes[attributeName] = [String(value)]
    if (legacyAttributeName) {
      attributes[legacyAttributeName] = [String(value)]
    }
  }

  await admin.users.update({ id: userId }, {
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    enabled: user.enabled,
    emailVerified: user.emailVerified,
    attributes
  })
}

export function getUserAttribute(user: KeycloakUser, attributeName: string): string {
  return user.attributes?.[attributeName]?.[0] ?? ''
}

export function getUserAttributeBoolean(user: KeycloakUser, attributeName: string): boolean {
  return user.attributes?.[attributeName]?.[0] === 'true'
}
