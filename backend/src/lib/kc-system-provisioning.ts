// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Runtime provisioning of Keycloak "system" clients that the proxy owns.
 *
 * These clients used to be baked into keycloak/realm-export.json WITH their
 * secrets in plaintext — a problem in a public repo, and a no-op on any existing
 * realm (Keycloak's --import-realm uses IGNORE_EXISTING). Instead the backend
 * reconciles them at startup as the admin-service service account (which holds
 * manage-clients), sourcing secrets from config/env. Idempotent and non-fatal:
 * a failure logs a warning and leaves the realm untouched.
 */
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { config } from '../config'
import { logger } from './logger'
import { audienceMapper } from './audience-mapper'
import { RESOURCE_INDICATORS_SCOPE } from './smart-client-enrichment'
import { ensureMappersOnScope } from './smart-scope-mappers'
import { getFhirResourceUrls } from './fhir-server-store'
import { SHL_EXCHANGE_CLIENT_SCOPES } from './shl-service-account'
import { derivedHomeUrl, usableHomeUrl } from './client-home-url'
import { RESOURCE_URL_ATTR, exchangeResourceServerIds } from './resource-server-exchange'

/** Keycloak client attribute: let this client introspect tokens it isn't in the aud of. */
const ALLOW_INTROSPECTION_WITHOUT_AUDIENCE = 'allow.token.introspection.without.audience.check'

/** Audiences the resource-indicators scope maps. fhir-* is export-owned but still needs a mapper. */
export const RESOURCE_AUDIENCE_CLIENT_IDS = ['fhir-resource-server', 'mcp-resource-server'] as const


/** SMART app type. The only marker an export-seeded app carries. */
const CLIENT_TYPE_ATTR = 'client_type'

/** Keycloak client attribute gating RFC 8628 device authorization. */
const DEVICE_GRANT_ATTR = 'oauth2.device.authorization.grant.enabled'

/**
 * Non-login "resource server" client that exists only to hold a `resource_url`.
 *
 * WHY THIS IS RECONCILED AT RUNTIME. These were created by hand (and by
 * .github/scripts/deploy-beta-remote.sh section 10b) with URLs baked in per
 * environment. Production never ran that script, so its clients still carried
 * DEV defaults — an access token minted there came back with
 *
 *   aud: ["http://localhost:8445/mcp", "realm-management"]
 *
 * on the live production system. `http://localhost:8445/mcp` can never match
 * getMcpResourceAudience() in production, so audience binding silently pointed at
 * nothing. Deriving the URL from config instead means it is correct in every
 * environment by construction, and cannot drift from what the proxy validates.
 */
/**
 * ONLY the MCP resource client is reconciled here. `fhir-resource-server` is
 * deliberately excluded, and that exclusion is load-bearing.
 *
 * Keycloak matches the token request's `resource` parameter against `resource_url`
 * EXACTLY. The FHIR resource identifier is the full proxy FHIR base, which
 * includes the server id and FHIR version chosen at runtime:
 *
 *   http://localhost:8445/proxy-smart-backend/hapi-fhir-server/R4
 *
 * None of that is derivable from static config — `config.name` is the package
 * name (`proxy-smart`), not the URL segment (`proxy-smart-backend`), and the
 * server id and version come from the runtime FHIR-server registry.
 * getFhirResourceAudiences() looks similar but is a VALIDATION PREFIX, matched at
 * a path boundary; it is not a resource identifier.
 *
 * An earlier version of this function derived the FHIR url from those pieces and
 * overwrote the correct value with `${baseUrl}/${name}/` on every startup, so
 * every token exchange requesting the FHIR resource failed:
 *
 *   POST /auth/token → 400 {"error":"invalid_target"}
 *
 * The FHIR client's resource_url therefore stays owned by the realm export and
 * the deploy script, which set it per environment.
 */
const RESOURCE_SERVER_CLIENTS = [
  {
    clientId: 'mcp-resource-server',
    name: 'MCP Resource Server (RFC 8707 resource indicator)',
    description: 'Non-login resource client. Holds resource_url = the proxy MCP URL.',
    /**
     * Exactly getMcpResourceAudience() — a single unambiguous URL with no runtime
     * component, which is why this one is safe to derive.
     */
    resourceUrl: () => `${config.baseUrl}${config.mcp.path}`,
  },
] as const

/** Client ids this module owns. Exported so tests can assert the scope. */
export const RESOURCE_SERVER_CLIENT_IDS = RESOURCE_SERVER_CLIENTS.map((c) => c.clientId)

/**
 * The resource_url this module would set for a given client id.
 * Exported so a test can compare it against the realm export, which is the check
 * that would have caught the invalid_target regression.
 */
export function resourceServerUrlFor(clientId: string): string | undefined {
  return RESOURCE_SERVER_CLIENTS.find((c) => c.clientId === clientId)?.resourceUrl()
}

/**
 * Ensure the RFC 8707 resource-server clients exist with the CURRENT environment's
 * resource URLs.
 *
 * Idempotent: creates what is missing, and updates `resource_url` when it drifts
 * (for example after a domain change, or on an environment seeded from another's
 * export). Non-fatal — a failure leaves the realm untouched and logs a warning,
 * because audience binding degrading is preferable to the backend refusing to boot.
 */
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
          // A resource client is never logged into and never mints tokens; it
          // exists purely as a named audience.
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
      if (client.attributes?.[RESOURCE_URL_ATTR] === resourceUrl) {
        logger.keycloak.debug('Resource-server client already correct', { clientId: spec.clientId })
        continue
      }

      await admin.clients.update(
        { id: client.id! },
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

/**
 * `fhir-resource-server` — the resource client for the proxy FHIR base. Its
 * `resource_url` carries the runtime server id + FHIR version (see
 * fhirResourceUrlFor), so unlike the MCP client it is NOT safe to derive-and-
 * overwrite on every boot: an earlier version did exactly that with a wrong
 * value and broke every FHIR token exchange with `invalid_target`.
 *
 * So this is strictly CREATE-IF-MISSING. Environments whose realm export /
 * deploy script already set the value keep it untouched; an environment that
 * never got it (production imports with IGNORE_EXISTING, and only the beta
 * deploy runs the reconcile script) has the gap filled with the URL the proxy
 * itself advertises for its first FHIR server. If no server resolves yet, it is
 * skipped — a later boot with the registry warm creates it.
 *
 * The `resource-indicators` scope already maps `fhir-resource-server` as an
 * audience; without this client that mapper points at nothing and the FHIR
 * `aud` cannot bind.
 */
async function ensureFhirResourceServerClient(admin: KcAdminClient): Promise<void> {
  const clientId = 'fhir-resource-server'
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

/**
 * Ensure the RFC 8707 `resource-indicators` client scope exists.
 *
 * Only the realm-export declared it, and --import-realm skips existing realms, so
 * production never got it. assignResourceIndicatorsScope() then silently no-ops and
 * every proxy-registered client (including Claude's DCR client) loses its audience
 * binding — MCP connect fails at the token step, after the user has consented.
 */
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

    // Repair rather than skip: /admin/smart-scopes can create the name but drops
    // protocolMappers, so a scope that exists is not necessarily one that works.
    const added = await ensureMappersOnScope(
      admin,
      existing.id,
      RESOURCE_INDICATORS_SCOPE,
      audiences.map(resourceAudienceMapper),
    )

    if (existing.attributes?.['include.in.token.scope'] !== 'false') {
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

/**
 * Clients needing the resource-indicators scope to bind a requested `resource`
 * into `aud`.
 *
 * Two markers, not one: `smart_app` is written only when a client is CREATED
 * (admin API + DCR), so keying on it alone permanently skipped export-seeded
 * apps, which carry `client_type` — every token exchange they tried returned
 * `invalid_target`. Resource clients are excluded: they are the audience, never
 * the requester.
 */
export function needsResourceIndicators(client: ClientRepresentation): boolean {
  if (!client.id) return false
  if (RESOURCE_AUDIENCE_CLIENT_IDS.includes(client.clientId as typeof RESOURCE_AUDIENCE_CLIENT_IDS[number])) return false
  return client.attributes?.smart_app !== undefined || client.attributes?.[CLIENT_TYPE_ATTR] !== undefined
}

/**
 * Attach the scope to clients that already existed when it was created.
 *
 * New clients get it at registration (assignResourceIndicatorsScope), but a realm
 * that gained the scope late leaves everything created before it without one.
 * Membership comes from {@link needsResourceIndicators}.
 */
async function attachResourceIndicatorsToExistingClients(
  admin: KcAdminClient,
  scopeId: string,
): Promise<void> {
  const clients = await admin.clients.find()
  const managed = clients.filter(needsResourceIndicators)

  let attached = 0
  for (const client of managed) {
    try {
      const current = await admin.clients.listDefaultClientScopes({ id: client.id! })
      if (current.some((s) => s.name === RESOURCE_INDICATORS_SCOPE)) continue
      await admin.clients.addDefaultClientScope({ id: client.id!, clientScopeId: scopeId })
      attached++
    } catch (error) {
      logger.keycloak.warn('Could not attach resource-indicators to client', {
        clientId: client.clientId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (attached) logger.keycloak.info('Attached resource-indicators to existing clients', { attached })
}

/**
 * Reconcile the full RFC 8707 resource-indicator wiring on demand — the resource
 * clients (including the create-only fhir-resource-server), the
 * resource-indicators scope, and its audience mappers. This is the same work
 * `ensureSystemClients` runs at boot, exposed so an operator can repair a drifted
 * or partially-imported realm without a redeploy (e.g. via the admin API / MCP).
 * Returns the resulting resource clients for confirmation. Idempotent; each step
 * is individually non-fatal.
 */
/**
 * Backfill `baseUrl` on SMART clients that predate it being set at registration.
 *
 * Keycloak renders "Back to Application" on its error and page-expired screens
 * from the client's baseUrl. Clients registered before resolveClientHomeUrl was
 * wired in have none, so every failed login on them offered a link to the theme's
 * PROXY_PUBLIC_URL — this proxy's API host — instead of the app the launch came
 * from. New clients get it at registration; this fixes the ones already there.
 *
 * Only fills a blank. An operator who set a baseUrl by hand in the Keycloak admin
 * console meant it, and a redirect URI is a worse source of truth than that.
 */
export async function reconcileClientHomeUrls(
  admin: KcAdminClient,
): Promise<{ clientId: string; baseUrl: string }[]> {
  const clients = await admin.clients.find()
  const updated: { clientId: string; baseUrl: string }[] = []

  for (const client of clients) {
    if (!client.id || !client.clientId) continue
    if (client.attributes?.['smart_app'] !== 'true') continue
    if (usableHomeUrl(client.baseUrl)) continue

    // Same inputs, same precedence as registration: a declared client_uri wins
    // over a redirect origin. Dynamic registration persists it as
    // `smart.client_uri`, so leaving it out here would have resolved a worse
    // answer than the client actually gave us.
    const baseUrl = derivedHomeUrl({
      clientUri: client.attributes?.['smart.client_uri'],
      launchUrl: client.attributes?.['launch_url'],
      redirectUris: client.redirectUris,
    })
    if (!baseUrl) continue

    await admin.clients.update({ id: client.id }, { baseUrl })
    updated.push({ clientId: client.clientId, baseUrl })
    logger.admin.info('Backfilled client baseUrl', { clientId: client.clientId, baseUrl })
  }

  return updated
}

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

/**
 * Ensure the proxy's introspection client (admin-service) may introspect tokens
 * whose `aud` does not list it.
 *
 * Keycloak 26.6.2+ (CVE-2026-37979 hardening) only lets a client introspect
 * tokens that carry it in `aud`. The proxy introspects on behalf of resource
 * servers as `admin-service`, which is never in a SMART token's audience — and
 * with RFC 8707 the `aud` is narrowed to the bare resource URL, so NO client
 * qualifies. Result: every valid token introspects as `active:false`. Relaxing
 * the check for admin-service (the proxy's own trusted client) restores correct
 * introspection without widening the trust boundary. Declared in realm-export
 * too; this reconciles the existing realm (import is a no-op once it exists).
 */
export async function ensureIntrospectionClientConfig(admin: KcAdminClient): Promise<void> {
  const clientId = config.keycloak.adminClientId
  if (!clientId) return
  try {
    const found = await admin.clients.find({ clientId })
    if (found.length === 0) return
    const client = found[0]
    const attributes = { ...(client.attributes ?? {}) }
    if (attributes[ALLOW_INTROSPECTION_WITHOUT_AUDIENCE] === 'true') return
    attributes[ALLOW_INTROSPECTION_WITHOUT_AUDIENCE] = 'true'
    await admin.clients.update({ id: client.id! }, { clientId, attributes })
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

/**
 * Ensure the SHL token-exchange client exists and its secret matches config.
 *
 * The SHL flow authenticates as this confidential service-account client to mint
 * scoped, short-lived tokens (RFC 8693). Its secret lives ONLY in config (env /
 * secret store); this reconciles the Keycloak side to it so the two never drift
 * and no secret is committed to the repo. No-op when SHL is not configured.
 */
export async function ensureShlExchangeClient(admin: KcAdminClient): Promise<void> {
  if (!config.shlExchange.isConfigured) {
    logger.keycloak.info('SHL exchange client secret not configured — skipping SHL client reconcile')
    return
  }

  const clientId = config.shlExchange.clientId
  const secret = config.shlExchange.clientSecret!

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

    if (existing.length === 0) {
      await admin.clients.create(desired)
      logger.keycloak.info('Created SHL exchange client', { clientId })
      return
    }

    // Reconcile the secret on the existing client so Keycloak matches config.
    const internalId = existing[0].id!
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

/**
 * Ensure the admin webapp client may start the RFC 8628 device authorization grant.
 *
 * This is how `proxy-smart login` works: the CLI has no browser and no client
 * secret, so it starts a device flow against the admin-ui client and polls. With
 * the grant disabled Keycloak refuses at the first step:
 *
 *   HTTP 400 {"error":"unauthorized_client",
 *             "error_description":"Client is not allowed to initiate OAuth 2.0
 *                                  Device Authorization Grant."}
 *
 * ALL THREE realm exports already declare the attribute — and it still was not
 * set on production. Same reason as every other drift in this file:
 * `--import-realm` is IGNORE_EXISTING, so a realm that already exists never picks
 * up anything added to the export afterwards. Beta only had it because
 * .github/scripts/deploy-beta-remote.sh reconciles it at deploy time, and
 * production does not run that script. Reconciling here makes it true in every
 * environment by construction rather than in whichever one happened to run a
 * shell script.
 */
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
    if (client.attributes?.[DEVICE_GRANT_ATTR] === 'true') return

    await admin.clients.update(
      { id: client.id! },
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
