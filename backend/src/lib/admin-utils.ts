// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KeycloakAdminClient from '@keycloak/keycloak-admin-client'
import type UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation.js'
import { logger } from './logger'
import { parseFhirPersons } from './fhir-person-associations'

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

export async function getValidatedAdmin(
  getAdmin: (token: string) => Promise<KeycloakAdminClient>,
  token: string
): Promise<KeycloakAdminClient> {
  logger.debug('admin', 'getValidatedAdmin called', { tokenLength: token.length })
  
  try {
    const adminClient = await getAdmin(token)
    return adminClient
  } catch (error) {
    logger.error('admin', 'Error in getValidatedAdmin', { 
      error: error instanceof Error ? error.message : String(error),
      errorType: error?.constructor?.name,
      stack: error instanceof Error ? error.stack : undefined
    })
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('401') || 
        errorMessage.includes('Unauthorized') || 
        errorMessage.includes('Invalid token') ||
        errorMessage.includes('Token expired') ||
        errorMessage.includes('authentication')) {
      logger.warn('admin', 'Detected authentication error, throwing AuthenticationError')
      throw new AuthenticationError(`Authentication failed: ${errorMessage}`);
    }
    
    logger.warn('admin', 'Detected non-authentication error, throwing generic Error')
    throw new Error(`Failed to get admin client: ${errorMessage}`, { cause: error });
  }
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
