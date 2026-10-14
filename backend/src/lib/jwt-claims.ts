// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { decodeJwt, type JWTPayload } from 'jose'
import { isRecord, optionalString, stringArray } from './type-guards'

/** A JWT's claims WITHOUT verifying it, for bookkeeping keyed on a token Keycloak has already judged. Null when opaque. */
export function readUnverifiedClaims(token: string): JWTPayload | null {
  try {
    return decodeJwt(token)
  } catch {
    return null
  }
}

/** Any decoded claim set: jose's JWTPayload and jsonwebtoken's JwtPayload both fit. */
export type ClaimSet = { readonly [claim: string]: unknown }

export interface RoleList {
  roles: string[]
}

/** The Keycloak-specific claims this backend reads, each present only when well-formed. */
export interface KeycloakClaims {
  sub?: string
  preferred_username?: string
  email?: string
  name?: string
  realm_access?: RoleList
  resource_access?: Record<string, RoleList>
}

function roleList(value: unknown): RoleList | undefined {
  if (!isRecord(value)) return undefined
  const roles = stringArray(value.roles)
  return roles ? { roles } : undefined
}

function resourceAccess(value: unknown): Record<string, RoleList> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).flatMap(([client, access]) => {
    const list = roleList(access)
    return list ? [[client, list] as const] : []
  })
  return Object.fromEntries(entries)
}

/** Narrow a decoded token's Keycloak claims; a malformed claim reads as absent. */
export function readKeycloakClaims(payload: ClaimSet): KeycloakClaims {
  return {
    sub: optionalString(payload.sub),
    preferred_username: optionalString(payload.preferred_username),
    email: optionalString(payload.email),
    name: optionalString(payload.name),
    realm_access: roleList(payload.realm_access),
    resource_access: resourceAccess(payload.resource_access),
  }
}
