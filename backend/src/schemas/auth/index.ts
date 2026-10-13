// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Authentication schemas barrel file
 * 
 * Re-exports all authentication-related schemas:
 * - OAuth and OpenID Connect (oauth.ts)
 * - Dynamic Client Registration (client-registration.ts)
 */

export * from './oauth'
export * from './client-registration'
export * from './task-launch'
