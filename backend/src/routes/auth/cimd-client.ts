// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The proxy's stand-in for a client named by its Client ID Metadata Document: a Keycloak client whose clientId is the
 * document URL, so tokens carry the client's own identifier. Keycloak sees only the proxy callback; the proxy checks
 * the client's redirect_uri against the document itself.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { Value } from '@sinclair/typebox/value'
import { resolveCimdDocument, type CimdDocument, type CimdRefusal } from '@proxy-smart/auth'
import { ClientRegistrationRequest, type ClientRegistrationSettingsType } from '@/schemas'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { isTrustedCimdHost, trustedCimdDomains } from '@/lib/cimd-policy'
import { getServiceAccountAdmin } from '@/lib/service-account-admin'
import { refreshCorsOrigins } from '@/lib/cors-origins'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { smartLogger } from '@/lib/smart-logger'
import { logger } from '@/lib/logger'
import { config } from '@/config'
import { resourceAudienceResolver } from '@/lib/resource-audience'
import { getClientRegistrationSettings } from '../admin/client-registration-settings'
import { CIMD_CLIENT_ATTRIBUTE, buildDcrClient } from './dcr-client'
import { configureClientScopes, vetRegistration } from './client-provisioning'

/** An operator's decisions on a stand-in survive every refresh from the document. */
const OPERATOR_ATTRIBUTES = ['approved', 'approval_required', 'registration_date'] as const

const READY_TTL_MS = 5 * 60 * 1000

export interface CimdStandInDeps {
  admin: () => Promise<KcAdminClient>
  settings: (admin: KcAdminClient) => Promise<ClientRegistrationSettingsType>
  trustedDomains: () => Promise<string[]>
  resolveDocument: (clientId: string) => Promise<CimdDocument | null>
  /** True for an identifier another party already holds here, an issuer or a resource, which a client may not take (draft §10.1). */
  isPartyIdentifier: (clientId: string) => Promise<boolean>
  now?: () => number
}

function originOf(url: string | null): string[] {
  if (!url) return []
  try {
    return [new URL(url).origin]
  } catch {
    return []
  }
}

/** Anything on the proxy's or Keycloak's origin, and every resource the realm issues tokens for. */
export async function isPartyIdentifier(clientId: string): Promise<boolean> {
  const ownOrigins = [config.baseUrl, config.oauthIssuer, config.keycloak.expectedIssuer].flatMap(originOf)
  if (ownOrigins.includes(new URL(clientId).origin)) return true
  return (await resourceAudienceResolver.audienceFor(clientId)) !== null
}

const refuse = (error: CimdRefusal['error'], error_description: string): CimdRefusal => ({ error, error_description })

/** The client as the user sees it: its own name, with the host that vouches for it (draft §10.6). */
export function displayName(clientId: string, clientName: string | undefined): string {
  const { host } = new URL(clientId)
  return clientName && clientName !== host ? `${clientName} (${host})` : host
}

function refreshedStandIn(existing: ClientRepresentation, next: ClientRepresentation): ClientRepresentation {
  const kept = Object.fromEntries(OPERATOR_ATTRIBUTES.flatMap((key) => {
    const value = existing.attributes?.[key]
    return value === undefined ? [] : [[key, value]]
  }))
  return { ...existing, ...next, enabled: existing.enabled, attributes: { ...existing.attributes, ...next.attributes, ...kept } }
}

export function createCimdStandIn(deps: CimdStandInDeps): (clientId: string) => Promise<CimdRefusal | null> {
  const now = deps.now ?? Date.now
  const ready = new TtlCache<string>({ ttlMs: READY_TTL_MS, maxEntries: 1000 })
  const inFlight = new Map<string, Promise<CimdRefusal | null>>()

  async function upsert(admin: KcAdminClient, representation: ClientRepresentation, grantedScope: string | undefined): Promise<ClientRepresentation> {
    const clientId = representation.clientId ?? ''
    const [existing] = await admin.clients.find({ clientId })
    if (existing?.id) {
      if (existing.attributes?.[CIMD_CLIENT_ATTRIBUTE] !== 'true') return existing
      const refreshed = refreshedStandIn(existing, representation)
      await admin.clients.update({ id: existing.id }, refreshed)
      return refreshed
    }
    try {
      const { id } = await admin.clients.create(representation)
      await configureClientScopes(admin, id, clientId, grantedScope)
      logger.auth.info('Created the stand-in for a CIMD client', { clientId })
      return { ...representation, id }
    } catch (error) {
      // Another instance may have created it between the lookup and the create.
      const [raced] = await admin.clients.find({ clientId })
      if (raced?.attributes?.[CIMD_CLIENT_ATTRIBUTE] === 'true') return raced
      throw error
    }
  }

  async function prepare(clientId: string): Promise<CimdRefusal | null> {
    if (!isTrustedCimdHost(clientId, await deps.trustedDomains())) {
      return refuse('unauthorized_client', `${new URL(clientId).host} is not trusted to name clients by metadata document`)
    }

    try {
      if (await deps.isPartyIdentifier(clientId)) {
        logger.auth.warn('A CIMD client_id names an issuer or resource of this server', { clientId })
        return refuse('unauthorized_client', 'This client identifier belongs to this server or one of its resources')
      }
    } catch (error) {
      logger.auth.error("Could not check a CIMD client_id against this server's identifiers", { clientId, error })
      return refuse('temporarily_unavailable', 'The authorization server cannot accept this client right now')
    }

    const document = await deps.resolveDocument(clientId)
    if (!document) return refuse('invalid_request', 'The client metadata document could not be retrieved, or is not valid')
    const metadata = document.metadata
    if (!Value.Check(ClientRegistrationRequest, metadata)) {
      return refuse('invalid_request', 'The client metadata document is not valid RFC 7591 client metadata')
    }

    const fingerprint = JSON.stringify(metadata)
    if (ready.get(clientId) === fingerprint) return null

    let admin: KcAdminClient
    let settings: ClientRegistrationSettingsType
    try {
      admin = await deps.admin()
      settings = await deps.settings(admin)
    } catch (error) {
      logger.auth.error('Could not reach Keycloak to stand in for a CIMD client', { clientId, error })
      return refuse('temporarily_unavailable', 'The authorization server cannot accept this client right now')
    }

    const vetting = await vetRegistration(metadata, settings)
    if (!vetting.ok) return refuse('invalid_request', `The client metadata document was refused: ${vetting.error_description}`)

    const { representation } = buildDcrClient({
      clientId,
      body: { ...metadata, client_name: displayName(clientId, metadata.client_name) },
      settings,
      registration: { via: 'metadata-document' },
      now: now(),
    })

    let standIn: ClientRepresentation
    try {
      standIn = await upsert(admin, representation, vetting.grantedScope)
    } catch (error) {
      logger.auth.error('Could not create or refresh the stand-in for a CIMD client', { clientId, error })
      return refuse('temporarily_unavailable', 'The authorization server cannot accept this client right now')
    }
    if (standIn.attributes?.[CIMD_CLIENT_ATTRIBUTE] !== 'true') {
      logger.auth.warn('A CIMD client_id names a client registered another way; refusing to take it over', { clientId })
      return refuse('unauthorized_client', 'This client identifier is registered to another client')
    }
    if (standIn.enabled === false) return refuse('unauthorized_client', 'This client is awaiting approval by an administrator')

    refreshCorsOrigins().catch(() => {})
    ready.set(clientId, fingerprint)
    return null
  }

  return (clientId: string) => {
    const pending = inFlight.get(clientId)
    if (pending) return pending
    const started = prepare(clientId).finally(() => inFlight.delete(clientId))
    inFlight.set(clientId, started)
    return started
  }
}

export const standInForCimdClient = createCimdStandIn({
  admin: getServiceAccountAdmin,
  settings: getClientRegistrationSettings,
  trustedDomains: trustedCimdDomains,
  resolveDocument: (clientId) => resolveCimdDocument(clientId, { logger: smartLogger, urlPolicy: outboundUrlPolicy }),
  isPartyIdentifier,
})
