// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const library = join(import.meta.dir, '../../.github/scripts/beta-keycloak.sh').replace(/\\/g, '/')

interface Keycloak {
  container?: boolean
  signIn?: boolean
  realms?: string[]
  renameStatus?: number
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'beta-realm-'))
  writeFileSync(join(dir, '.env.beta'), 'KEYCLOAK_ADMIN_PASSWORD=secret\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function ensureRealm(realm: string, keycloak: Keycloak) {
  const { container = true, signIn = true, realms = [], renameStatus = 204 } = keycloak
  const listing = JSON.stringify(['master', ...realms].map((name) => ({ id: `id-${name}`, realm: name })))
  const puts = join(dir, 'puts').replace(/\\/g, '/')
  rmSync(puts, { force: true })
  const stubs = `
docker() { ${container ? "echo 172.18.0.5" : 'return 0'}; }
sleep() { :; }
curl() {
  case "$*" in
    *openid-connect/token*) cat >/dev/null; ${signIn ? `echo '{"access_token":"tok"}'` : 'return 22'} ;;
    *briefRepresentation*) echo '${listing}' ;;
    *"-X PUT"*) printf '%s\\n' "$*" >> '${puts}'; echo ${renameStatus} ;;
    *) return 0 ;;
  esac
}
`
  const script = ['set -euo pipefail', stubs, `REALM='${realm}'`, `. '${library}'`, 'ensure_live_realm_name', 'echo DONE'].join('\n')
  const run = Bun.spawnSync(['bash', '-c', script], { cwd: dir })
  return {
    ok: run.exitCode === 0 && run.stdout.toString().includes('DONE'),
    output: run.stdout.toString() + run.stderr.toString(),
    renames: existsSync(puts) ? readFileSync(puts, 'utf8').trim().split('\n') : [],
  }
}

describe('beta realm name', () => {
  it('leaves a realm that already carries the declared name alone', () => {
    const result = ensureRealm('maxhealth', { realms: ['maxhealth'] })
    expect(result.ok).toBe(true)
    expect(result.renames).toEqual([])
  })

  it('renames the one live realm to the declared name before the new image imports', () => {
    const result = ensureRealm('maxhealth', { realms: ['proxy-smart'] })
    expect(result.ok).toBe(true)
    expect(result.renames).toHaveLength(1)
    expect(result.renames[0]).toContain('/admin/realms/proxy-smart')
    expect(result.renames[0]).toContain('{"realm":"maxhealth"}')
  })

  it('lets a Keycloak without a realm import the declaration fresh', () => {
    expect(ensureRealm('maxhealth', { realms: [] })).toMatchObject({ ok: true, renames: [] })
  })

  it('lets a first deploy without a Keycloak container go ahead', () => {
    expect(ensureRealm('maxhealth', { container: false })).toMatchObject({ ok: true, renames: [] })
  })

  it('stops when several realms could be the one the declaration replaces', () => {
    expect(ensureRealm('maxhealth', { realms: ['proxy-smart', 'other'] })).toMatchObject({ ok: false, renames: [] })
  })

  it('stops when a running Keycloak refuses the admin sign-in', () => {
    expect(ensureRealm('maxhealth', { signIn: false, realms: ['proxy-smart'] }).ok).toBe(false)
  })

  it('stops when Keycloak refuses the rename', () => {
    expect(ensureRealm('maxhealth', { realms: ['proxy-smart'], renameStatus: 409 }).ok).toBe(false)
  })
})
