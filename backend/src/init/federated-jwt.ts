// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Everything private_key_jwt client authentication needs on the Keycloak side.
 *
 * The proxy IS the token endpoint SMART clients talk to, so it validates their
 * assertions itself and re-signs one for Keycloak. Keycloak accepts that only
 * when four things hold, and `--import-realm` establishes none of them on an
 * existing realm:
 *
 *   1. admin-service may manage identity providers (added after first import)
 *   2. the proxy-smart-signing IdP points at this deployment's JWKS and URLs
 *   3. the realm's client-auth flow contains the federated-jwt execution
 *   4. each JWKS-registered client uses the federated-jwt authenticator
 *
 * Each step is idempotent and non-fatal on its own, so a partial failure
 * degrades one client's authentication rather than startup.
 */

import { config } from '../config'
import { logger } from '../lib/logger'
import { getAdminClient, invalidateAdminToken } from '../lib/kc-admin-factory'
import { proxySigningJwksUrl, isReachableFromKeycloak } from '../lib/proxy-signing-url'
import type AdminClient from '@keycloak/keycloak-admin-client'

export const IDP_ALIAS = 'proxy-smart-signing'
const CUSTOM_FLOW_ALIAS = 'clients with federated-jwt'
const IDP_ROLE = 'manage-identity-providers'

const asMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Grant admin-service the role it needs to manage identity providers.
 *
 * Realms imported before the IdP existed have an admin-service without it. The
 * account already holds manage-users, which is enough to assign itself a role,
 * so the reconcile can bootstrap its own permission.
 */
async function ensureIdpManagementRole(admin: AdminClient): Promise<void> {
  try {
    const [realmMgmt] = await admin.clients.find({ clientId: 'realm-management' })
    if (!realmMgmt?.id) return

    const [svcClient] = await admin.clients.find({ clientId: config.keycloak.adminClientId! })
    if (!svcClient?.id) return

    const svcUser = await admin.clients.getServiceAccountUser({ id: svcClient.id })
    if (!svcUser?.id) return

    const currentRoles = await admin.users.listClientRoleMappings({
      id: svcUser.id,
      clientUniqueId: realmMgmt.id,
    })
    if (currentRoles.some(role => role.name === IDP_ROLE)) return

    const availableRoles = await admin.clients.listRoles({ id: realmMgmt.id })
    const idpRole = availableRoles.find(role => role.name === IDP_ROLE)
    if (!idpRole?.id) return

    await admin.users.addClientRoleMappings({
      id: svcUser.id,
      clientUniqueId: realmMgmt.id,
      roles: [{ id: idpRole.id, name: IDP_ROLE }],
    })
    logger.keycloak.info(`Assigned ${IDP_ROLE} role to admin-service`)

    /*
     * The cached token predates the role. admin.auth() cannot replace it — the
     * factory registers a token provider, which takes precedence in
     * getAccessToken() — so drop the cached one and let the next request mint a
     * bearer that actually carries manage-identity-providers.
     */
    invalidateAdminToken()
  } catch (error) {
    logger.keycloak.debug('Could not self-assign IdP role (may already have it)', {
      error: asMessage(error),
    })
  }
}

/**
 * Create or reconcile the proxy-smart-signing IdP.
 *
 * Every expected key is compared, not a subset: a realm seeded from another
 * environment otherwise keeps that environment's tokenUrl and authorizationUrl
 * forever, because those two were never compared and so never converged.
 */
async function reconcileSigningIdp(admin: AdminClient): Promise<void> {
  const token = await admin.getAccessToken()
  const idpUrl = `${config.keycloak.baseUrl}/admin/realms/${config.keycloak.realm}/identity-provider/instances/${IDP_ALIAS}`

  const kcHost = new URL(config.keycloak.baseUrl!).hostname
  const jwksUrl = proxySigningJwksUrl(kcHost, config.proxySigningJwksUrl, config.port)

  /*
   * Refuse to write a URL Keycloak cannot resolve. `backend` is a docker-compose service name, and
   * on ECS (or any host-per-service deployment) there is nothing behind it — Keycloak then cannot
   * fetch our JWKS, cannot verify a proxy-signed assertion, and EVERY private_key_jwt client fails
   * with `invalid_client`. That was production for months. Leaving a correct config in place beats
   * replacing it with a broken one, so this reconciles nothing and says why.
   */
  if (!isReachableFromKeycloak(jwksUrl, kcHost)) {
    logger.keycloak.warn(
      'Refusing to reconcile proxy-smart-signing: the derived JWKS URL is unreachable from Keycloak. ' +
        'Set PROXY_SIGNING_JWKS_URL to a URL Keycloak can fetch (the public base URL works when it has egress).',
      { jwksUrl, keycloakHost: kcHost },
    )
    return
  }

  const expectedConfig = {
    issuer: config.baseUrl,
    tokenUrl: `${config.baseUrl}/auth/token`,
    authorizationUrl: `${config.baseUrl}/auth/authorize`,
    clientId: 'keycloak',
    clientSecret: 'unused',
    useJwksUrl: 'true',
    jwksUrl,
    validateSignature: 'true',
    clientAuthMethod: 'client_secret_post',
    supportsClientAssertions: 'true',
    // Backend signing trust anchor, never a user-facing login option.
    hideOnLoginPage: 'true',
  }

  const representation = {
    alias: IDP_ALIAS,
    displayName: 'Proxy Smart Signing',
    providerId: 'oidc',
    enabled: true,
    trustEmail: false,
    storeToken: false,
    linkOnly: false,
  }

  const getRes = await fetch(idpUrl, { headers: { Authorization: `Bearer ${token}` } })

  if (getRes.ok) {
    const existing = await getRes.json() as { config?: Record<string, string> }
    const drifted = Object.entries(expectedConfig)
      .filter(([key, value]) => existing.config?.[key] !== value)
      .map(([key]) => key)

    if (drifted.length === 0) {
      logger.keycloak.info('✅ proxy-smart-signing IdP already configured correctly')
      return
    }

    logger.keycloak.info('Reconciling proxy-smart-signing IdP', { drifted })
    const putRes = await fetch(idpUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...representation,
        // Merge so config keys we do not manage survive the reconcile.
        config: { ...existing.config, ...expectedConfig },
      }),
    })

    if (putRes.ok) {
      logger.keycloak.info('✅ proxy-smart-signing IdP updated', { synced: drifted })
    } else {
      logger.keycloak.warn(`Failed to update proxy-smart-signing IdP (${putRes.status}): ${await putRes.text()}`)
    }
    return
  }

  // 404 means it does not exist; 403 means the first check predated the role
  // self-assignment above, so creating it is still worth a try.
  if (getRes.status !== 404 && getRes.status !== 403) {
    logger.keycloak.warn(`Unexpected response checking proxy-smart-signing IdP: ${getRes.status}`)
    return
  }
  if (getRes.status === 403) {
    logger.keycloak.info('Got 403 checking IdP — retrying after role self-assignment')
  }

  const createUrl = `${config.keycloak.baseUrl}/admin/realms/${config.keycloak.realm}/identity-provider/instances`
  const postRes = await fetch(createUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...representation, hideOnLogin: true, config: expectedConfig }),
  })

  if (postRes.ok || postRes.status === 201) {
    logger.keycloak.info('✅ proxy-smart-signing IdP created')
  } else {
    logger.keycloak.warn(`Failed to create proxy-smart-signing IdP (${postRes.status}): ${await postRes.text()}`)
  }
}

/**
 * Ensure the realm's client-auth flow can authenticate a federated-jwt client.
 *
 * A realm created before `--features=client-auth-federated` has a built-in
 * "clients" flow without the "Signed JWT - Federated" execution, and built-in
 * flows cannot be modified — so the flow is copied, extended and bound.
 */
async function ensureFederatedJwtFlow(admin: AdminClient): Promise<void> {
  try {
    const flows = await admin.authenticationManagement.getFlows()
    const realmInfo = await admin.realms.findOne({ realm: config.keycloak.realm! })
    const currentFlowAlias = realmInfo?.clientAuthenticationFlow || 'clients'

    try {
      const executions = await admin.authenticationManagement.getExecutions({ flow: currentFlowAlias })
      if (executions.some((execution: { providerId?: string }) => execution.providerId === 'federated-jwt')) {
        logger.keycloak.debug('Client auth flow already has federated-jwt execution')
        return
      }
    } catch { /* flow not found — fall through and create the custom one */ }

    if (!flows.some(flow => flow.alias === CUSTOM_FLOW_ALIAS)) {
      await admin.authenticationManagement.copyFlow({ flow: 'clients', newName: CUSTOM_FLOW_ALIAS })
      logger.keycloak.info('Copied built-in "clients" flow')
    }

    const customExecutions = await admin.authenticationManagement.getExecutions({ flow: CUSTOM_FLOW_ALIAS })
    if (!customExecutions.some((execution: { providerId?: string }) => execution.providerId === 'federated-jwt')) {
      await admin.authenticationManagement.addExecutionToFlow({
        flow: CUSTOM_FLOW_ALIAS,
        provider: 'federated-jwt',
      })
      logger.keycloak.info('Added federated-jwt execution to client auth flow')

      // Keycloak adds an execution as DISABLED, which authenticates nobody.
      const updated = await admin.authenticationManagement.getExecutions({ flow: CUSTOM_FLOW_ALIAS })
      const federated = updated.find((execution: { providerId?: string }) => execution.providerId === 'federated-jwt')
      if (federated?.id) {
        await admin.authenticationManagement.updateExecution(
          { flow: CUSTOM_FLOW_ALIAS },
          { ...federated, requirement: 'ALTERNATIVE' },
        )
        logger.keycloak.info('Set federated-jwt execution to ALTERNATIVE')
      }
    }

    if (currentFlowAlias !== CUSTOM_FLOW_ALIAS) {
      await admin.realms.update({ realm: config.keycloak.realm! }, {
        ...realmInfo,
        clientAuthenticationFlow: CUSTOM_FLOW_ALIAS,
      })
      logger.keycloak.info('✅ Bound "clients with federated-jwt" as client authentication flow')
    }
  } catch (error) {
    logger.keycloak.warn('Could not ensure federated-jwt client auth flow', { error: asMessage(error) })
  }
}

/**
 * Migrate JWKS-registered clients onto the federated-jwt authenticator.
 *
 * `--import-realm` does not update existing clients, so a client imported as
 * `client-jwt` keeps that authenticator after realm-export.json moves to
 * `federated-jwt`, and the jwt.credential.* attributes can be missing entirely.
 * Affected clients are recognised by their JWKS registration.
 *
 * The full client representation goes into the PUT: a partial update resets
 * everything absent from it, service accounts and scopes included.
 */
async function migrateFederatedJwtClients(admin: AdminClient): Promise<void> {
  const clients = await admin.clients.find()
  let migrated = 0

  for (const client of clients) {
    if (!client.id || !client.clientId) continue

    const attributes: Record<string, string> = client.attributes ?? {}
    if (attributes['use.jwks.string'] !== 'true') continue

    const needsAuthType = client.clientAuthenticatorType !== 'federated-jwt'
    const needsCredAttrs = attributes['jwt.credential.issuer'] !== IDP_ALIAS
      || attributes['jwt.credential.sub'] !== client.clientId
    const needsServiceAccount = !client.serviceAccountsEnabled

    if (!needsAuthType && !needsCredAttrs && !needsServiceAccount) continue

    try {
      await admin.clients.update({ id: client.id }, {
        ...client,
        clientAuthenticatorType: 'federated-jwt',
        serviceAccountsEnabled: true,
        attributes: {
          ...attributes,
          'jwt.credential.issuer': IDP_ALIAS,
          'jwt.credential.sub': client.clientId,
        },
      })
      migrated++
      logger.keycloak.info(`Migrated client "${client.clientId}" to federated-jwt auth`, {
        fixedAuthType: needsAuthType,
        fixedCredAttrs: needsCredAttrs,
        fixedServiceAccount: needsServiceAccount,
      })
    } catch (error) {
      logger.keycloak.warn(`Failed to migrate client "${client.clientId}" to federated-jwt`, {
        error: asMessage(error),
      })
    }
  }

  if (migrated > 0) {
    logger.keycloak.info(`✅ Migrated ${migrated} client(s) to federated-jwt`)
  }
}

/**
 * Reconcile the four prerequisites of federated-jwt client authentication.
 */
export async function ensureProxySigningIdp(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping proxy-signing IdP check — no admin credentials configured')
    return
  }

  try {
    await ensureIdpManagementRole(admin)
    await reconcileSigningIdp(admin)
    await ensureFederatedJwtFlow(admin)
    await migrateFederatedJwtClients(admin)
  } catch (error) {
    logger.keycloak.warn('Could not ensure proxy-smart-signing IdP exists', { error: asMessage(error) })
  }
}
