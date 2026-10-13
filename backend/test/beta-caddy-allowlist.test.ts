// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

import { authRoutes } from '../src/routes/auth'

const COMPOSE = readFileSync(join(import.meta.dir, '..', '..', 'docker-compose.beta.yml'), 'utf8')

function caddyPaths(matcher: string): string[] {
  const line = COMPOSE.split(/\r?\n/).find((l) => l.trim().startsWith(`caddy.${matcher}.path:`))
  const value = line?.slice(line.indexOf(':') + 1).trim().replace(/^"|"$/g, '') ?? ''
  return value.split(/\s+/).filter(Boolean)
}

/** Caddy: a trailing * is a prefix match; a * elsewhere matches within one segment. */
function caddyMatches(patterns: string[], path: string): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === path
    if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) return path.startsWith(pattern.slice(0, -1))
    const regex = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
    return regex.test(path)
  })
}

describe('beta reverse proxy allowlist', () => {
  it('leaves every /auth route to the backend rather than Keycloak', () => {
    const keycloak = caddyPaths('@keycloak')
    const routes = [...new Set(authRoutes.routes.map((r) => r.path.replace(/:[^/]+/g, 'x').replace(/\*$/, 'x')))]
    expect(routes.filter((path) => caddyMatches(keycloak, path))).toEqual([])
  })

  it('exposes the Keycloak account console that management_endpoint points at', () => {
    const keycloak = caddyPaths('@keycloak')
    for (const path of ['/auth/realms/proxy-smart/account', '/auth/realms/proxy-smart/account/applications']) {
      expect(caddyMatches(keycloak, path)).toBe(true)
    }
  })
})
