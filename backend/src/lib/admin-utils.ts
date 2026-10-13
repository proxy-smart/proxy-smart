// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KeycloakAdminClient from '@keycloak/keycloak-admin-client'
import type UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation.js'
import { logger } from './logger'
import { parseFhirPersons } from './fhir-person-associations'

// Use Keycloak's official UserRepresentation type
type KeycloakUser = UserRepresentation

/**
 * Extract and validate Bearer token from request headers
 * @param headers Request headers object
 * @returns Token string or null if not found
 */
export function extractBearerToken(headers: Record<string, string | undefined>): string | null {
  const authorization = headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    return null
  }
  return authorization.replace('Bearer ', '')
}

/**
 * Standard error response for missing authentication
 */
export const UNAUTHORIZED_RESPONSE = {
  error: 'Authorization header required'
}

/**
 * Custom error class for authentication-related errors
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The token is valid and authentic, but its ROLES do not confer admin access.
 *
 * Distinct from {@link AuthenticationError} so callers can tell the two apart. They previously
 * could not: `validateAdminToken` threw AuthenticationError both when the token's audience was
 * wrong (a client/integration mistake) and when the user simply lacked a role (a grant mistake),
 * and the admin guard answered both with `403 "Admin permissions required"`. That message sent
 * this session's own debugging down the wrong path for several turns — a DCR-audienced token was
 * reported as a missing-role problem when its roles were fine.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Custom error class for configuration-related errors
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Get admin client with proper error handling
 * @param getAdmin Admin client factory function
 * @param token Bearer token
 * @returns Admin client instance
 * @throws AuthenticationError for auth-related issues, Error for other issues
 */
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
    
    // Check if the error is authentication-related
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Common authentication error patterns
    if (errorMessage.includes('401') || 
        errorMessage.includes('Unauthorized') || 
        errorMessage.includes('Invalid token') ||
        errorMessage.includes('Token expired') ||
        errorMessage.includes('authentication')) {
      logger.warn('admin', 'Detected authentication error, throwing AuthenticationError')
      throw new AuthenticationError(`Authentication failed: ${errorMessage}`);
    }
    
    // For any other errors, throw as server error
    logger.warn('admin', 'Detected non-authentication error, throwing generic Error')
    throw new Error(`Failed to get admin client: ${errorMessage}`, { cause: error });
  }
}

/**
 * Common user mapping function for consistent user profile responses
 * @param user Keycloak user object
 * @returns Standardized user profile
 */
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

/**
 * Set user attribute safely (handles array conversion)
 * @param admin Keycloak admin client
 * @param userId User ID
 * @param attributeName Attribute name
 * @param value Attribute value
 * @param legacyAttributeName Optional legacy attribute name for backwards compatibility
 */
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
    // Remove attribute
    delete attributes[attributeName]
    if (legacyAttributeName) {
      delete attributes[legacyAttributeName]
    }
  } else {
    // Set attribute (convert to array format for Keycloak)
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

/**
 * Get user attribute safely
 * @param user Keycloak user object
 * @param attributeName Attribute name
 * @returns Attribute value or empty string
 */
export function getUserAttribute(user: KeycloakUser, attributeName: string): string {
  return user.attributes?.[attributeName]?.[0] ?? ''
}

/**
 * Get user attribute as boolean
 * @param user Keycloak user object
 * @param attributeName Attribute name
 * @returns Boolean value
 */
export function getUserAttributeBoolean(user: KeycloakUser, attributeName: string): boolean {
  return user.attributes?.[attributeName]?.[0] === 'true'
}
