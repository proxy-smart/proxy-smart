// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { logger } from '../lib/logger'
import { getAdminClient } from '../lib/kc-admin-factory'

/**
 * First-login flow for an identity provider that verifies email ownership itself: a new email
 * becomes a user, a known one is linked to its account, with no confirmation screen. Assign it
 * only to such a provider (and set trustEmail), since linking by email trusts that provider's
 * word that the person controls the address.
 */
export const TRUSTED_EMAIL_FIRST_BROKER_LOGIN = 'trusted email first broker login'
const LINKING_SUBFLOW = 'trusted email user creation or linking'
const REVIEW_PROFILE_CONFIG = 'trusted email review profile'

export type FlowAdmin = Pick<KcAdminClient['authenticationManagement'],
  'getFlows' | 'createFlow' | 'addExecutionToFlow' | 'addFlowToFlow' | 'getExecutions' | 'updateExecution' | 'createConfig'>

const EXPECTED: ReadonlyArray<{ providerId?: string; displayName?: string; requirement: string }> = [
  { providerId: 'idp-review-profile', requirement: 'REQUIRED' },
  { displayName: LINKING_SUBFLOW, requirement: 'REQUIRED' },
  { providerId: 'idp-create-user-if-unique', requirement: 'ALTERNATIVE' },
  { providerId: 'idp-auto-link', requirement: 'ALTERNATIVE' },
]

async function build(auth: FlowAdmin): Promise<void> {
  await auth.createFlow({
    alias: TRUSTED_EMAIL_FIRST_BROKER_LOGIN,
    description: 'Creates a user for a new email and links a known one, without asking. Only for providers that verify email ownership.',
    providerId: 'basic-flow',
    topLevel: true,
    builtIn: false,
  })
  await auth.addExecutionToFlow({ flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN, provider: 'idp-review-profile' })
  await auth.addFlowToFlow({
    flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN,
    alias: LINKING_SUBFLOW,
    type: 'basic-flow',
    provider: 'registration-page-form',
    description: 'Create the user, or link the account the email already belongs to',
  })
  await auth.addExecutionToFlow({ flow: LINKING_SUBFLOW, provider: 'idp-create-user-if-unique' })
  await auth.addExecutionToFlow({ flow: LINKING_SUBFLOW, provider: 'idp-auto-link' })

  for (const execution of await auth.getExecutions({ flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN })) {
    const want = EXPECTED.find((e) => (e.providerId ?? e.displayName) === (execution.providerId ?? execution.displayName))
    if (want && execution.requirement !== want.requirement) {
      await auth.updateExecution({ flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN }, { ...execution, requirement: want.requirement })
    }
    if (execution.providerId === 'idp-review-profile' && execution.id) {
      // Asks only when the provider left out a field the realm requires.
      await auth.createConfig({ id: execution.id, alias: REVIEW_PROFILE_CONFIG, config: { 'update.profile.on.first.login': 'missing' } })
    }
  }
}

/** What differs from the expected flow, empty when it matches. */
async function drift(auth: FlowAdmin): Promise<string[]> {
  const executions = await auth.getExecutions({ flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN })
  return EXPECTED.flatMap((want) => {
    const have = executions.find((e) => (want.providerId ? e.providerId === want.providerId : e.displayName === want.displayName))
    if (!have) return [`${want.providerId ?? want.displayName} is missing`]
    return have.requirement === want.requirement ? [] : [`${want.providerId ?? want.displayName} is ${have.requirement}, expected ${want.requirement}`]
  })
}

/** Creates the flow when the realm lacks it; one that has drifted is reported, not rewritten. */
export async function reconcileTrustedEmailFirstBrokerLogin(auth: FlowAdmin): Promise<'created' | 'present' | 'drifted'> {
  const flows = await auth.getFlows()
  if (!flows.some((flow) => flow.alias === TRUSTED_EMAIL_FIRST_BROKER_LOGIN)) {
    await build(auth)
    return 'created'
  }
  const findings = await drift(auth)
  if (findings.length === 0) return 'present'
  logger.keycloak.warn('The trusted email first broker login flow differs from what Proxy Smart expects', { findings })
  return 'drifted'
}

export async function ensureTrustedEmailFirstBrokerLogin(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) return
  try {
    const outcome = await reconcileTrustedEmailFirstBrokerLogin(admin.authenticationManagement)
    logger.keycloak.info('Trusted email first broker login flow reconciled', { outcome })
  } catch (error) {
    logger.keycloak.warn('Could not reconcile the trusted email first broker login flow', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
