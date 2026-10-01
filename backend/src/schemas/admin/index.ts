// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin schemas - Re-export all admin-related schemas
 * 
 * This index file provides a single entry point for all admin schemas
 * while maintaining the modular structure in separate files.
 */

// Common/Shared schemas
export * from './common'

// Domain-specific schemas
export * from './users'
export * from './smart-apps'
export * from './roles'
export * from './fhir-servers'
export * from './dicom-servers'
export * from './mtls'
export * from './identity-providers'
export * from './keycloak'
export * from './organizations'
export * from './user-federation'
export * from './mcp-endpoint'
export * from './branding'
export * from './scope-mappers'
export * from './protocol-mappers'
export * from './smart-scopes'
export * from './client-policies'
export * from './auth-flows'
export * from './scope-sets'