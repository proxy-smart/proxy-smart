// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The SMART launch context a token response carries: added after Keycloak issued the token,
 * persisted by access-token and refresh-token jti, and handed on to the tokens a refresh mints.
 */

import { logger } from '@/lib/logger'
import { validateToken } from '@/lib/auth'
import { readUnverifiedClaims } from '@/lib/jwt-claims'
import { fhirResourceUrlFor, getAllServers, type FHIRServerInfo } from '@/lib/fhir-server-store'
import { getSmartClientConfig } from '@/lib/smart-client-config-cache'
import { resolveFhirUserForClient } from '@/lib/consent/person-resolver'
import { recordLastLogin } from '@/lib/last-login'
import { tokenContextStore, sanitizeFhirContext, type TokenContext } from '@/lib/token-context-store'
import type { TokenActor } from '@/lib/token-actor'
import { smartProxyConfig, smartStore, smartLogger } from '../smart-proxy-setup'
import {
  enrichTokenResponse,
  toAbsoluteFhirUser,
  extractPatientFromFhirUser,
  canReturnPatient,
  canReturnEncounter,
  canReturnFhirUser,
  parseScopes,
  type TokenPayload,
} from '@proxy-smart/auth'
import { generateAuthorizationDetails } from './shared'

export type TokenResponseBody = Record<string, unknown>

export interface ExchangeContext {
  act: TokenActor
  patient?: string
}

/** Audience binding guards resources; the endpoint describing its own grant is not one. */
export const readGrantedToken = (token: string) => validateToken(token, { enforceAudience: false })

const stringClaim = (claims: Record<string, unknown> | null | undefined, name: string): string | undefined => {
  const value = claims?.[name]
  return typeof value === 'string' && value ? value : undefined
}

const numberClaim = (claims: Record<string, unknown> | null | undefined, name: string): number | undefined => {
  const value = claims?.[name]
  return typeof value === 'number' && value > 0 ? value : undefined
}

/** A refresh token's own jti, else its session and client, which a refresh token without jti still names. */
function refreshTokenKey(claims: Record<string, unknown> | null): string | undefined {
  const jti = stringClaim(claims, 'jti')
  if (jti) return jti
  const sid = stringClaim(claims, 'sid')
  const azp = stringClaim(claims, 'azp')
  return sid && azp ? `sid:${sid}:${azp}` : undefined
}

/**
 * The context stored for the refresh token a refresh grant presented. Called only after Keycloak
 * answered 200, which is what makes the unverified claims trustworthy.
 */
export async function carriedRefreshContext(refreshToken: string, clientId: string | undefined): Promise<TokenContext | null> {
  const claims = readUnverifiedClaims(refreshToken)
  const key = refreshTokenKey(claims)
  if (!key) return null
  return tokenContextStore.getForRefreshToken(key, clientId ?? stringClaim(claims, 'azp'))
}

/** The registered server the authorization's `aud` named, else the first one. */
async function fhirServerFor(aud: string | undefined): Promise<FHIRServerInfo | null> {
  const servers = await getAllServers()
  const wanted = aud?.replace(/\/+$/, '')
  return servers.find((server) => fhirResourceUrlFor(server) === wanted) ?? servers[0] ?? null
}

function applyCarried(data: TokenResponseBody, carried: TokenContext, granted: Set<string>): void {
  if (carried.patient && canReturnPatient(granted)) data.patient = carried.patient
  if (carried.encounter && canReturnEncounter(granted)) data.encounter = carried.encounter
  if (carried.fhirUser && canReturnFhirUser(granted)) data.fhirUser = carried.fhirUser
  if (carried.fhirContext) data.fhirContext = carried.fhirContext
  if (carried.intent) data.intent = carried.intent
  if (carried.smart_style_url) data.smart_style_url = carried.smart_style_url
  if (carried.tenant) data.tenant = carried.tenant
  if (carried.need_patient_banner !== undefined) data.need_patient_banner = carried.need_patient_banner
}

/** The launch context fields of a token response, as the store keeps them. */
function contextOf(data: TokenResponseBody): TokenContext {
  return {
    patient: stringClaim(data, 'patient'),
    encounter: stringClaim(data, 'encounter'),
    fhirUser: stringClaim(data, 'fhirUser'),
    fhirContext: sanitizeFhirContext(data.fhirContext),
    intent: stringClaim(data, 'intent'),
    smart_style_url: stringClaim(data, 'smart_style_url'),
    tenant: stringClaim(data, 'tenant'),
    need_patient_banner: typeof data.need_patient_banner === 'boolean' ? data.need_patient_banner : undefined,
  }
}

const hasLaunchContext = (context: TokenContext) => Object.values(context).some((value) => value !== undefined)

export interface LaunchContextInput {
  accessToken: string
  clientId?: string
  redirectUri?: string
  code?: string
  /** The resource the authorization was for; fhirUser is made absolute against its server. */
  sessionAud?: string
  grantType?: string
  exchange?: ExchangeContext | null
  /** Context stored for the refresh token this grant redeemed. */
  carried?: TokenContext | null
}

/**
 * Add the SMART launch context to a successful token response and persist it.
 *
 * Never throws: enrichment failing must not turn an issued token into an error,
 * so the caller keeps Keycloak's response as it stands.
 */
export async function applyLaunchContext(data: TokenResponseBody, input: LaunchContextInput): Promise<void> {
  try {
    await addLaunchContext(data, input)
  } catch (error) {
    logger.auth.warn('Failed to add launch context to token response', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function addLaunchContext(data: TokenResponseBody, input: LaunchContextInput): Promise<void> {
  const { accessToken, clientId, redirectUri, code, grantType, exchange, carried } = input
  const tokenPayload: TokenPayload = await readGrantedToken(accessToken)
  const grantedScope = typeof data.scope === 'string' ? data.scope : ''
  const granted = parseScopes(grantedScope)

  if (grantType === 'authorization_code' && typeof tokenPayload.sub === 'string') {
    void recordLastLogin(tokenPayload.sub)
  }

  const enrichment = enrichTokenResponse(
    { tokenPayload, clientId, redirectUri, code, grantedScope },
    { config: smartProxyConfig, store: smartStore, logger: smartLogger },
  )
  for (const [key, value] of Object.entries(enrichment)) {
    if (value !== undefined) data[key] = value
  }
  if (carried) applyCarried(data, carried, granted)
  if (!data.patient && exchange?.patient) data.patient = exchange.patient

  if (!data.fhirUser && tokenPayload.fhirUser && canReturnFhirUser(granted)) {
    const server = await fhirServerFor(input.sessionAud)
    const fhirBaseUrl = server ? fhirResourceUrlFor(server) : ''
    const clientConfig = await getSmartClientConfig(clientId || '')
    // Resolved upstream: through fhirBaseUrl the app's own token is refused for want of the context this establishes.
    const resolvedFhirUser = await resolveFhirUserForClient(
      tokenPayload.fhirUser, clientConfig.patientFacing, server?.url || fhirBaseUrl,
      server?.identifier || '', `Bearer ${accessToken}`,
    )
    if (resolvedFhirUser) data.fhirUser = toAbsoluteFhirUser(resolvedFhirUser, fhirBaseUrl)
  }

  if (!data.patient && typeof data.fhirUser === 'string' && canReturnPatient(granted)) {
    const patient = extractPatientFromFhirUser(data.fhirUser)
    if (patient) data.patient = patient
  }

  const generatedDetails = await generateAuthorizationDetails()
  if (generatedDetails) data.authorization_details = generatedDetails

  await persistLaunchContext(data, tokenPayload, {
    clientId,
    act: exchange?.act ?? carried?.act,
  })
}

/**
 * SMART 2.2 §Token Introspection repeats the token response's context, and a refresh hands it on,
 * so it is stored by the access token's jti and by the refresh token's.
 */
async function persistLaunchContext(
  data: TokenResponseBody,
  tokenPayload: TokenPayload,
  binding: { clientId?: string; act?: TokenActor },
): Promise<void> {
  const context = contextOf(data)
  if (!hasLaunchContext(context) && !binding.act) return

  const clientId = stringClaim(tokenPayload, 'azp') ?? binding.clientId
  const stored: TokenContext = {
    ...context,
    clientId,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    ...(binding.act && { act: binding.act }),
  }

  const accessJti = stringClaim(tokenPayload, 'jti')
  if (accessJti) await tokenContextStore.set(accessJti, { ...stored, exp: numberClaim(tokenPayload, 'exp') })

  const refreshClaims = typeof data.refresh_token === 'string' ? readUnverifiedClaims(data.refresh_token) : null
  const refreshKey = refreshTokenKey(refreshClaims)
  if (refreshKey) await tokenContextStore.setForRefreshToken(refreshKey, { ...stored, exp: numberClaim(refreshClaims, 'exp') })
}
