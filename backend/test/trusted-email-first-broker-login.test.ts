// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { reconcileTrustedEmailFirstBrokerLogin, TRUSTED_EMAIL_FIRST_BROKER_LOGIN, type FlowAdmin } from '../src/init/broker-flows'

interface Execution { id: string; providerId?: string; displayName?: string; requirement: string; flow: string }

/** Keycloak's flow store, as far as the reconciler uses it: getExecutions lists nested ones too. */
function fakeKeycloak() {
  const flows = new Set<string>()
  const children = new Map<string, string>()
  const executions: Execution[] = []
  const configs = new Map<string, Record<string, string>>()
  let next = 0
  const inFlow = (flow: string): Execution[] => executions.flatMap((e) => e.flow !== flow ? [] : [e, ...(e.displayName && children.has(e.displayName) ? inFlow(e.displayName) : [])])
  const admin: FlowAdmin = {
    getFlows: async () => [...flows].map((alias) => ({ alias })),
    createFlow: async (flow) => { if (flow?.alias) flows.add(flow.alias); return flow ?? {} },
    addExecutionToFlow: async (payload) => {
      const execution = { id: `e${next++}`, providerId: payload?.provider, requirement: 'DISABLED', flow: payload?.flow ?? '' }
      executions.push(execution)
      return execution
    },
    addFlowToFlow: async (payload) => {
      executions.push({ id: `e${next++}`, displayName: payload?.alias, requirement: 'DISABLED', flow: payload?.flow ?? '' })
      children.set(payload?.alias ?? '', payload?.flow ?? '')
      return { alias: payload?.alias }
    },
    getExecutions: async (payload) => inFlow(payload?.flow ?? '').map(({ flow: _flow, ...execution }) => execution),
    updateExecution: async (_query, execution) => {
      const stored = executions.find((e) => e.id === execution.id)
      if (stored && execution.requirement) stored.requirement = execution.requirement
    },
    createConfig: async (config) => { configs.set(config?.id ?? '', config?.config ?? {}); return config ?? {} },
  }
  return { admin, executions, configs }
}

describe('the trusted email first broker login flow', () => {
  it('is created with no screen for a new or a known email, and a profile review only for missing fields', async () => {
    const keycloak = fakeKeycloak()
    expect(await reconcileTrustedEmailFirstBrokerLogin(keycloak.admin)).toBe('created')
    const steps = (await keycloak.admin.getExecutions({ flow: TRUSTED_EMAIL_FIRST_BROKER_LOGIN }))
      .map((e) => `${e.providerId ?? e.displayName}:${e.requirement}`)
    expect(steps).toEqual([
      'idp-review-profile:REQUIRED',
      'trusted email user creation or linking:REQUIRED',
      'idp-create-user-if-unique:ALTERNATIVE',
      'idp-auto-link:ALTERNATIVE',
    ])
    expect([...keycloak.configs.values()]).toEqual([{ 'update.profile.on.first.login': 'missing' }])
  })

  it('leaves a matching flow alone and reports one someone changed', async () => {
    const keycloak = fakeKeycloak()
    await reconcileTrustedEmailFirstBrokerLogin(keycloak.admin)
    expect(await reconcileTrustedEmailFirstBrokerLogin(keycloak.admin)).toBe('present')
    const autoLink = keycloak.executions.find((e) => e.providerId === 'idp-auto-link')
    if (autoLink) autoLink.requirement = 'DISABLED'
    expect(await reconcileTrustedEmailFirstBrokerLogin(keycloak.admin)).toBe('drifted')
  })
})
