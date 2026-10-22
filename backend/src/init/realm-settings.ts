// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Realm settings reconciled on every startup.
 *
 * All of these exist because `--import-realm` is a no-op once the realm exists,
 * so a setting added to realm-export.json after the first deployment reaches
 * fresh realms only, never prod or beta. Reconciling here covers all three.
 *
 * Every step is idempotent and non-fatal: a realm that cannot be read or
 * written must not stop the server from starting.
 */

import { config } from '../config'
import { logger } from '../lib/logger'
import { getAdminClient } from '../lib/kc-admin-factory'
import { ENABLED_EVENT_TYPES } from '../lib/keycloak-event-types'
import type KcAdminClient from '@keycloak/keycloak-admin-client'

type Realm = NonNullable<Awaited<ReturnType<KcAdminClient['realms']['findOne']>>>
type RealmPatch = Parameters<KcAdminClient['realms']['update']>[1]

interface RealmReconciliation {
  /** Names the step in skip and failure logs, e.g. 'SMTP setup'. */
  name: string
  isSatisfied: (realm: Realm) => boolean
  satisfiedMessage: string
  patch: (realm: Realm) => RealmPatch
  updatedMessage: string
  updatedMeta?: (realm: Realm) => Record<string, unknown>
}

/**
 * Read the realm, compare, write only when it differs.
 *
 * Four settings were four copies of this: the same credential guard, the same
 * findOne, the same already-satisfied early return, the same swallowed error.
 */
async function reconcileRealm(step: RealmReconciliation): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug(`Skipping ${step.name} — no admin credentials configured`)
    return
  }

  try {
    const realm = await admin.realms.findOne({ realm: config.keycloak.realm! })
    if (!realm) {
      logger.keycloak.warn(`Could not read realm — skipping ${step.name}`)
      return
    }

    if (step.isSatisfied(realm)) {
      logger.keycloak.info(step.satisfiedMessage)
      return
    }

    await admin.realms.update({ realm: config.keycloak.realm! }, step.patch(realm))
    logger.keycloak.info(step.updatedMessage, step.updatedMeta?.(realm))
  } catch (error) {
    logger.keycloak.warn(`Could not reconcile ${step.name}`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Ensure Keycloak realm has SMTP configured and password reset enabled.
 * Uses RESEND_API_KEY env var.
 */
export async function ensureKeycloakSmtp(): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY
  if (!resendApiKey) {
    logger.keycloak.debug('Skipping SMTP setup — RESEND_API_KEY not configured')
    return
  }

  await reconcileRealm({
    name: 'SMTP setup',
    isSatisfied: realm => Boolean(realm.resetPasswordAllowed && realm.smtpServer?.host),
    satisfiedMessage: '✅ Keycloak SMTP and password reset already configured',
    patch: () => ({
      resetPasswordAllowed: true,
      smtpServer: {
        host: 'smtp.resend.dev',
        port: '465',
        from: 'noreply@maxhealth.tech',
        fromDisplayName: 'Proxy Smart',
        replyTo: 'noreply@maxhealth.tech',
        ssl: 'true',
        auth: 'true',
        user: 'resend',
        password: resendApiKey,
      },
    }),
    updatedMessage: '✅ Keycloak SMTP configured (Resend) and password reset enabled',
  })
}

const EVENTS_EXPIRATION_SECONDS = 7 * 24 * 60 * 60

const missingEventTypes = (enabled: readonly string[] | undefined): string[] =>
  ENABLED_EVENT_TYPES.filter((type) => !enabled?.includes(type))

/** Ensure the realm records every event type the event loggers poll for, keeping any an operator added. */
export async function ensureKeycloakEventLogging(): Promise<void> {
  await reconcileRealm({
    name: 'event-logging setup',
    isSatisfied: realm => Boolean(
      realm.eventsEnabled && realm.adminEventsEnabled && realm.adminEventsDetailsEnabled,
    ) && missingEventTypes(realm.enabledEventTypes).length === 0,
    satisfiedMessage: '✅ Keycloak event logging already enabled',
    patch: realm => ({
      eventsEnabled: true,
      adminEventsEnabled: true,
      adminEventsDetailsEnabled: true,
      eventsExpiration: realm.eventsExpiration ?? EVENTS_EXPIRATION_SECONDS,
      eventsListeners: realm.eventsListeners?.length ? realm.eventsListeners : ['jboss-logging'],
      enabledEventTypes: [...(realm.enabledEventTypes ?? []), ...missingEventTypes(realm.enabledEventTypes)],
    }),
    updatedMessage: '✅ Keycloak event logging enabled via Admin API',
  })
}

/**
 * Theme baked into the custom Keycloak image (Dockerfile.keycloak copies
 * keycloak/themes/proxy-smart). A thin override of `keycloak.v2` that adds
 * brand.css + idp-icons.css — see keycloak/themes/proxy-smart/login/theme.properties.
 */
const LOGIN_THEME = 'proxy-smart'

/**
 * Ensure the realm actually USES the login theme shipped in the image.
 *
 * Having the theme on disk is not enough — the realm has to select it, and no
 * realm-export sets `loginTheme`, so every realm had been falling back to stock
 * `keycloak.v2`: production rendered the default sign-in page with none of our
 * branding, loading neither brand.css nor idp-icons.css.
 */
export async function ensureLoginTheme(): Promise<void> {
  await reconcileRealm({
    name: 'login theme',
    isSatisfied: realm => realm.loginTheme === LOGIN_THEME,
    satisfiedMessage: '✅ Login theme already set',
    patch: () => ({ loginTheme: LOGIN_THEME }),
    updatedMessage: '✅ Login theme set on realm',
    updatedMeta: realm => ({ loginTheme: LOGIN_THEME, previous: realm.loginTheme ?? '(default)' }),
  })
}

/**
 * Ensure the realm has the Organizations feature enabled. KC 26+ ships it as
 * supported, but the Organizations Admin API 404s until the realm enables it.
 */
export async function ensureOrganizationsEnabled(): Promise<void> {
  await reconcileRealm({
    name: 'organizations',
    isSatisfied: realm => Boolean(realm.organizationsEnabled),
    satisfiedMessage: '✅ Keycloak Organizations already enabled',
    patch: () => ({ organizationsEnabled: true }),
    updatedMessage: '✅ Keycloak Organizations enabled on realm',
  })
}

/**
 * Required custom user-profile attributes for SMART on FHIR.
 * Keycloak 26+ Declarative User Profile silently drops undeclared attributes,
 * so every custom attribute we store must be listed here.
 */
const REQUIRED_USER_ATTRIBUTES = [
  { name: 'fhirUser', displayName: 'FHIR User Reference', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'patient_context', displayName: 'Patient Context (Admin)', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'encounter_context', displayName: 'Encounter Context (Admin)', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'fhir_persons', displayName: 'FHIR Person Associations', permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false },
  { name: 'organization', displayName: 'Organization', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'lastLogin', displayName: 'Last Login', permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false },
  // Imported from the Max Health IdP. Undeclared, the importer's write was dropped here in
  // silence: the mapper existed and reported healthy, the claim was always sent, and the
  // attribute simply never appeared — so every brokered user read as the `free` tier.
  { name: 'membership_tier', displayName: 'Max Health Membership Tier', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'early_access', displayName: 'Early Access', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
  { name: 'premium_support', displayName: 'Premium Support', permissions: { view: ['admin', 'user'], edit: ['admin'] }, multivalued: false },
]

/**
 * Ensure the User Profile declares every custom SMART attribute.
 *
 * Not part of reconcileRealm: the user profile lives behind its own admin
 * endpoint rather than the realm representation.
 */
export async function ensureUserProfileAttributes(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping user-profile check — no admin credentials configured')
    return
  }

  try {
    const profile = await admin.users.getProfile()
    const attributes = profile.attributes ?? []
    const declared = new Set(attributes.map(attribute => attribute.name))
    const missing = REQUIRED_USER_ATTRIBUTES.filter(attribute => !declared.has(attribute.name))

    if (missing.length === 0) {
      logger.keycloak.info('✅ User Profile already has all required attributes')
      return
    }

    await admin.users.updateProfile({ ...profile, attributes: [...attributes, ...missing] })

    logger.keycloak.info(`✅ User Profile updated — added ${missing.map(a => a.name).join(', ')}`)
  } catch (error) {
    logger.keycloak.warn('Could not auto-update User Profile attributes', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
