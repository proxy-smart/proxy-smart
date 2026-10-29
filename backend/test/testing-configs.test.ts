// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// `mode`: conformance writes fixtures (OAuth client, FHIR resources) so needs a disposable realm; enforcement writes nothing.
import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const TESTING_DIR = join(import.meta.dir, '..', '..', 'testing')

interface StageConfig {
  test_stage?: string
  target?: string
  mode?: string
  client?: { client_id?: string }
  test_user?: { username?: string; password?: string }
  probe?: { patient_id?: string }
}

const STAGES = readdirSync(TESTING_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(TESTING_DIR, name, 'inferno-config.json'))
      return true
    } catch {
      return false
    }
  })
  .map((name) => ({
    name,
    config: JSON.parse(
      readFileSync(join(TESTING_DIR, name, 'inferno-config.json'), 'utf8'),
    ) as StageConfig,
  }))

describe('compliance stage configs', () => {
  it('finds every stage', () => {
    expect(STAGES.length).toBeGreaterThan(0)
  })
})

describe.each(STAGES)('$name', ({ config }) => {
  it('declares a known mode', () => {
    expect(['conformance', 'enforcement']).toContain(config.mode ?? '(missing)')
  })

  it('names the identity it authenticates as', () => {
    // Enforcement signs a client assertion: no provisioned client permits a password grant.
    expect(config.client?.client_id).toBeTruthy()
    if (config.mode === 'conformance') expect(config.test_user?.username).toBeTruthy()
  })
})

const DEPLOYED = STAGES.filter((s) => s.config.target === 'deployed')

describe.each(DEPLOYED)('$name — deployed', ({ config }) => {
  it('carries no password', () => {
    // Public repo: deployed passwords come from CI secrets, including beta's conformance login.
    expect(config.test_user?.password).toBeUndefined()
  })
})

const ENFORCEMENT = STAGES.filter((s) => s.config.mode === 'enforcement')

describe.each(ENFORCEMENT)('$name — enforcement mode', ({ config }) => {
  it('declares the patient the probe requests', () => {
    // Never created: enforced consent yields 403; audit-only would proxy upstream and 404.
    expect(config.probe?.patient_id).toBeTruthy()
  })
})

describe('deployed environments', () => {
  it('runs the conformance suite only where fixtures may be created', () => {
    const deployedConformance = STAGES.filter(
      (s) => s.config.target === 'deployed' && s.config.mode === 'conformance',
    ).map((s) => s.name)

    expect(deployedConformance).toEqual(['beta'])
  })
})
