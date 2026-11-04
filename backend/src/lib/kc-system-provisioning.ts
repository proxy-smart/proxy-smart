// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Idempotent reconciliation of the Keycloak clients and scopes the proxy owns; --import-realm never updates an existing realm. */
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { config } from '../config'
import { logger } from './logger'
import { audienceMapper } from './audience-mapper'
import { RESOURCE_INDICATORS_SCOPE } from './smart-client-enrichment'
import { ensureMappersOnScope } from './smart-scope-mappers'
import { getFhirResourceUrls } from './fhir-server-store'
import { SHL_EXCHANGE_CLIENT_SCOPES } from './shl/service-account'
import { derivedHomeUrl, usableHomeUrl } from './client-home-url'
import { RESOURCE_URL_ATTR, exchangeResourceServerIds } from './resource-server-exchange'
import { FHIR_RESOURCE_CLIENT_ID, RESOURCE_AUDIENCE_CLIENT_IDS, isResourceAudienceClient } from './token-audience'
import { isSmartAppClient } from './realm-clients'

/** Keycloak client attribute: let this client introspect tokens it isn't in the aud of. */
const ALLOW_INTROSPECTION_WITHOUT_AUDIENCE = 'allow.token.introspection.without.audience.check'

export { RESOURCE_AUDIENCE_CLIENT_IDS }

/** Keycloak client attribute gating RFC 8628 device authorization. */
const DEVICE_GRANT_ATTR = 'oauth2.device.authorization.grant.enabled'

/** Only the MCP resource client is derived and overwritten: its URL has no runtime part. fhir-resource-server is create-only. */
const RESOURCE_SERVER_CLIENTS = [
  {
    clientId: 'mcp-resource-server',
    name: 'MCP Resource Server (RFC 8707 resource indicator)',
    description: 'Non-login resource client. Holds resource_url = the proxy MCP URL.',
    resourceUrl: () => `${config.baseUrl}${config.mcp.path}`,
  },
] as const

export const RESOURCE_SERVER_CLIENT_IDS = RESOURCE_SERVER_CLIENTS.map((c) => c.clientId)

export function resourceServerUrlFor(clientId: string): string | undefined {
  return RESOURCE_SERVER_CLIENTS.find((c) => c.clientId === clientId)?.resourceUrl()
}

/** Create missing resource-server clients and correct a drifted `resource_url`. */
export async function ensureResourceServerClients(admin: KcAdminClient): Promise<void> {
  for (const spec of RESOURCE_SERVER_CLIENTS) {
    const resourceUrl = spec.resourceUrl()
    try {
      const existing = await admin.clients.find({ clientId: spec.clientId, max: 1 })

      if (existing.length === 0) {
        await admin.clients.create({
          clientId: spec.clientId,
          name: spec.name,
          description: spec.description,
          enabled: true,
          protocol: 'openid-connect',
          clientAuthenticatorType: 'client-secret',
          publicClient: false,
          bearerOnly: false,
          // Exists only as a named audience: no login, no tokens.
          standardFlowEnabled: false,
          implicitFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: false,
          authorizationServicesEnabled: false,
          fullScopeAllowed: false,
          attributes: { [RESOURCE_URL_ATTR]: resourceUrl },
        })
        logger.keycloak.info('Created resource-server client', { clientId: spec.clientId, resourceUrl })
        continue
      }

      const client = existing[0]
      if (!client.id) continue
      if (client.attributes?.[RESOURCE_URL_ATTR] === resourceUrl) {
        logger.keycloak.debug('Resource-server client already correct', { clientId: spec.clientId })
        continue
      }

      await admin.clients.update(
        { id: client.id },
        { clientId: spec.clientId, attributes: { ...(client.attributes ?? {}), [RESOURCE_URL_ATTR]: resourceUrl } },
      )
      logger.keycloak.info('Reconciled resource_url on resource-server client', {
        clientId: spec.clientId,
        resourceUrl,
        previous: client.attributes?.[RESOURCE_URL_ATTR] ?? '(unset)',
      })
    } catch (error) {
      logger.keycloak.warn('Failed to reconcile resource-server client', {
        clientId: spec.clientId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await ensureFhirResourceServerClient(admin)
}

/** Create-only: an existing `resource_url` is left alone, since overwriting it once broke every FHIR exchange (invalid_target). */
async function ensureFhirResourceServerClient(admin: KcAdminClient): Promise<void> {
  const clientId = FHIR_RESOURCE_CLIENT_ID
  try {
    const existing = await admin.clients.find({ clientId, max: 1 })
    if (existing.length > 0) {
      logger.keycloak.debug('fhir-resource-server present — leaving its resource_url as owned by the realm export')
      return
    }

    const resourceUrl = (await getFhirResourceUrls())[0]
    if (!resourceUrl) {
      logger.keycloak.warn('fhir-resource-server missing and no FHIR server resolved yet — skipping (will retry next boot)')
      return
    }

    await admin.clients.create({
      clientId,
      name: 'FHIR Resource Server (RFC 8707 resource indicator)',
      description: 'Non-login resource client. Holds resource_url = the proxy FHIR base.',
      enabled: true,
      protocol: 'openid-connect',
      clientAuthenticatorType: 'client-secret',
      publicClient: false,
      bearerOnly: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      authorizationServicesEnabled: false,
      fullScopeAllowed: false,
      attributes: { [RESOURCE_URL_ATTR]: resourceUrl },
    })
    logger.keycloak.info('Created resource-server client', { clientId, resourceUrl })
  } catch (error) {
    logger.keycloak.warn('Failed to reconcile fhir-resource-server', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const resourceAudienceMapper = (clientId: string) => audienceMapper(clientId, 'client', `${clientId}-audience`)

/** The proxy's own resource clients, plus every client that is its own resource URL. */
async function resourceAudienceClientIds(admin: KcAdminClient): Promise<string[]> {
  const servers = await exchangeResourceServerIds(admin).catch((error: unknown) => {
    logger.keycloak.warn('Could not list exchange resource servers', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  })
  return [...new Set([...RESOURCE_AUDIENCE_CLIENT_IDS, ...servers])]
}

/** Create or repair the RFC 8707 `resource-indicators` scope and attach it to existing SMART clients. */
export async function ensureResourceIndicatorsScope(admin: KcAdminClient): Promise<void> {
  // Plumbing, not a requestable scope: hidden from token scope and consent.
  const attributes = { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' }
  const description =
    'RFC 8707 resource indicators: pre-populates access-token aud with resource-client ids so ' +
    'the resource-indicators post-processor can set aud to the requested resource.'

  try {
    const audiences = await resourceAudienceClientIds(admin)
    const existing = await admin.clientScopes.findOneByName({ name: RESOURCE_INDICATORS_SCOPE })

    if (!existing?.id) {
      await admin.clientScopes.create({
        name: RESOURCE_INDICATORS_SCOPE,
        description,
        protocol: 'openid-connect',
        attributes,
        protocolMappers: audiences.map(resourceAudienceMapper),
      })
      logger.keycloak.info('Created resource-indicators client scope', { audiences })
      const created = await admin.clientScopes.findOneByName({ name: RESOURCE_INDICATORS_SCOPE })
      if (created?.id) await attachResourceIndicatorsToExistingClients(admin, created.id)
      return
    }

    // /admin/smart-scopes can create the name without its mappers.
    const added = await ensureMappersOnScope(
      admin,
      existing.id,
      RESOURCE_INDICATORS_SCOPE,
      audiences.map(resourceAudienceMapper),
    )

    if (Object.entries(attributes).some(([key, value]) => existing.attributes?.[key] !== value)) {
      await admin.clientScopes.update({ id: existing.id }, {
        name: RESOURCE_INDICATORS_SCOPE,
        description,
        protocol: 'openid-connect',
        attributes: { ...(existing.attributes ?? {}), ...attributes },
      })
    }

    if (added) logger.keycloak.info('Repaired resource-indicators client scope', { added })

    await attachResourceIndicatorsToExistingClients(admin, existing.id)
  } catch (error) {
    logger.keycloak.warn('Failed to ensure resource-indicators client scope', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Drop a resource server's audience from the scope once it no longer is one. */
export async function removeResourceAudience(admin: KcAdminClient, clientId: string): Promise<void> {
  const scope = await admin.clientScopes.findOneByName({ name: RESOURCE_INDICATORS_SCOPE })
  if (!scope?.id) return
  const mappers = await admin.clientScopes.listProtocolMappers({ id: scope.id })
  const mapper = mappers.find((m) => m.name === `${clientId}-audience`)
  if (mapper?.id) await admin.clientScopes.delProtocolMapper({ id: scope.id, mapperId: mapper.id })
}

/** Clients needing the resource-indicators scope; resource clients are the audience, never the requester. */
export function needsResourceIndicators(client: ClientRepresentation): boolean {
  if (!client.id) return false
  if (isResourceAudienceClient(client.clientId)) return false
  return isSmartAppClient(client)
}

/** Attach the scope to clients created before it existed. */
async function attachResourceIndicatorsToExistingClients(
  admin: KcAdminClient,
  scopeId: string,
): Promise<void> {
  const clients = await admin.clients.find()
  const managed = clients.filter(needsResourceIndicators)

  let attached = 0
  for (const { id, clientId } of managed) {
    if (!id) continue
    try {
      const current = await admin.clients.listDefaultClientScopes({ id })
      if (current.some((s) => s.name === RESOURCE_INDICATORS_SCOPE)) continue
      await admin.clients.addDefaultClientScope({ id, clientScopeId: scopeId })
      attached++
    } catch (error) {
      logger.keycloak.warn('Could not attach resource-indicators to client', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (attached) logger.keycloak.info('Attached resource-indicators to existing clients', { attached })
}

/** Fill a missing or proxy-root client baseUrl (Keycloak's "Back to Application" link) from the client's own registration. */
export async function reconcileClientHomeUrls(
  admin: KcAdminClient,
): Promise<{ clientId: string; baseUrl: string }[]> {
  const clients = await admin.clients.find()
  const updated: { clientId: string; baseUrl: string }[] = []

  for (const client of clients) {
    if (!client.id || !client.clientId || !isSmartAppClient(client)) continue
    if (usableHomeUrl(client.baseUrl)) continue

    const baseUrl = derivedHomeUrl({
      clientUri: client.attributes?.['smart.client_uri'],
      launchUrl: client.attributes?.['launch_url'],
      redirectUris: client.redirectUris,
    })
    if (!baseUrl) continue

    try {
      await admin.clients.update({ id: client.id }, { baseUrl })
      updated.push({ clientId: client.clientId, baseUrl })
      logger.admin.info('Replaced client baseUrl', { clientId: client.clientId, previous: client.baseUrl, baseUrl })
    } catch (error) {
      logger.admin.warn('Could not replace client baseUrl', { clientId: client.clientId, error })
    }
  }

  return updated
}

/** On-demand run of the boot-time resource-indicator reconciliation. */
export async function reconcileResourceIndicators(
  admin: KcAdminClient,
): Promise<{ clientId: string; resourceUrl?: string }[]> {
  await ensureResourceServerClients(admin)
  await ensureResourceIndicatorsScope(admin)
  const summary: { clientId: string; resourceUrl?: string }[] = []
  for (const clientId of await resourceAudienceClientIds(admin)) {
    const found = await admin.clients.find({ clientId, max: 1 })
    summary.push({ clientId, resourceUrl: found[0]?.attributes?.[RESOURCE_URL_ATTR] })
  }
  return summary
}

/** Let the proxy's introspection client introspect tokens whose `aud` does not list it (Keycloak 26.6.2+). */
export async function ensureIntrospectionClientConfig(admin: KcAdminClient): Promise<void> {
  const clientId = config.keycloak.adminClientId
  if (!clientId) return
  try {
    const found = await admin.clients.find({ clientId })
    if (found.length === 0) return
    const client = found[0]
    if (!client.id) return
    const attributes = { ...(client.attributes ?? {}) }
    if (attributes[ALLOW_INTROSPECTION_WITHOUT_AUDIENCE] === 'true') return
    attributes[ALLOW_INTROSPECTION_WITHOUT_AUDIENCE] = 'true'
    await admin.clients.update({ id: client.id }, { clientId, attributes })
    logger.keycloak.info('Enabled introspection-without-audience-check on introspection client', { clientId })
  } catch (error) {
    logger.keycloak.warn('Failed to reconcile introspection client config', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Attach any of `names` missing from a client's optional scopes. Scopes absent from the realm are logged. */
async function ensureOptionalClientScopes(
  admin: KcAdminClient,
  internalId: string,
  clientId: string,
  names: readonly string[],
): Promise<void> {
  const current = new Set((await admin.clients.listOptionalClientScopes({ id: internalId })).map((s) => s.name))
  const attached: string[] = []
  for (const name of names.filter((n) => !current.has(n))) {
    const scope = await admin.clientScopes.findOneByName({ name })
    if (!scope?.id) {
      logger.keycloak.warn('Client scope missing from realm; cannot attach', { clientId, scope: name })
      continue
    }
    await admin.clients.addOptionalClientScope({ id: internalId, clientScopeId: scope.id })
    attached.push(name)
  }
  if (attached.length) logger.keycloak.info('Attached optional client scopes', { clientId, attached })
}

/** Create the SHL token-exchange client, or reset its secret to the configured one. */
export async function ensureShlExchangeClient(admin: KcAdminClient): Promise<void> {
  const secret = config.shlExchange.clientSecret
  if (!config.shlExchange.isConfigured || !secret) {
    logger.keycloak.info('SHL exchange client secret not configured — skipping SHL client reconcile')
    return
  }

  const clientId = config.shlExchange.clientId

  try {
    const existing = await admin.clients.find({ clientId })
    const desired = {
      clientId,
      name: 'SHL Token Exchange',
      description:
        'Service account for SMART Health Link token exchange (RFC 8693). Mints scoped, short-lived tokens for QR-based patient data sharing.',
      enabled: true,
      protocol: 'openid-connect',
      clientAuthenticatorType: 'client-secret',
      secret,
      publicClient: false,
      bearerOnly: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      authorizationServicesEnabled: false,
      fullScopeAllowed: false,
      defaultClientScopes: ['web-origins', 'acr', 'profile', 'roles', 'email'],
      optionalClientScopes: [...SHL_EXCHANGE_CLIENT_SCOPES],
      attributes: { 'access.token.lifespan': '3600' },
    }

    const internalId = existing[0]?.id
    if (!internalId) {
      await admin.clients.create(desired)
      logger.keycloak.info('Created SHL exchange client', { clientId })
      return
    }

    await admin.clients.update({ id: internalId }, { clientId, secret })
    logger.keycloak.debug('Reconciled SHL exchange client secret', { clientId })
    await ensureOptionalClientScopes(admin, internalId, clientId, SHL_EXCHANGE_CLIENT_SCOPES)
  } catch (error) {
    logger.keycloak.warn('Failed to reconcile SHL exchange client', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Enable RFC 8628 device authorization on the admin UI client, which `proxy-smart login` uses. */
export async function ensureAdminUiDeviceGrant(admin: KcAdminClient): Promise<void> {
  const clientId = config.keycloak.adminUiClientId
  if (!clientId) return

  try {
    const existing = await admin.clients.find({ clientId, max: 1 })
    if (existing.length === 0) {
      logger.keycloak.debug('Admin UI client not found — skipping device-grant reconcile', { clientId })
      return
    }

    const client = existing[0]
    if (!client.id || client.attributes?.[DEVICE_GRANT_ATTR] === 'true') return

    await admin.clients.update(
      { id: client.id },
      { clientId, attributes: { ...(client.attributes ?? {}), [DEVICE_GRANT_ATTR]: 'true' } },
    )
    logger.keycloak.info('Enabled device-authorization grant on the admin UI client', {
      clientId,
      previous: client.attributes?.[DEVICE_GRANT_ATTR] ?? '(unset)',
    })
  } catch (error) {
    logger.keycloak.warn('Failed to reconcile admin-ui device-authorization grant', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
