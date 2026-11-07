// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { withPublicIdentity } from '../src/lib/capability-identity'

const IDENTITY = { software: 'Proxy Smart', description: 'Clinical records' }
const PROXY_BASE = 'https://api.example.com/proxy-smart-backend/hapi-fhir-server/R4'

const upstream = JSON.stringify({
  resourceType: 'CapabilityStatement',
  text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">HAPI FHIR Server</div>' },
  name: 'RestServer',
  status: 'active',
  software: { name: 'HAPI FHIR Server', version: '8.6.5' },
  implementation: { description: 'HAPI FHIR R4 Server', url: PROXY_BASE },
  fhirVersion: '4.0.1',
  rest: [{ mode: 'server' }],
})

describe('withPublicIdentity', () => {
  it('presents the deployment instead of the upstream software and its version', () => {
    const statement = JSON.parse(withPublicIdentity(upstream, IDENTITY))
    expect(statement.software).toEqual({ name: 'Proxy Smart' })
    expect(statement.implementation).toEqual({ description: 'Clinical records', url: PROXY_BASE })
    expect(statement.name).toBeUndefined()
    expect(statement.text).toBeUndefined()
    expect(JSON.stringify(statement)).not.toContain('HAPI')
  })

  it('keeps everything a client negotiates with', () => {
    const statement = JSON.parse(withPublicIdentity(upstream, IDENTITY))
    expect(statement).toMatchObject({ status: 'active', fhirVersion: '4.0.1', rest: [{ mode: 'server' }] })
  })

  it('passes a body that is not a CapabilityStatement through untouched', () => {
    const outcome = JSON.stringify({ resourceType: 'OperationOutcome', issue: [] })
    expect(withPublicIdentity(outcome, IDENTITY)).toBe(outcome)
    expect(withPublicIdentity('<html>bad gateway</html>', IDENTITY)).toBe('<html>bad gateway</html>')
  })
})
