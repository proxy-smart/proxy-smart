// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Login identity providers belong to the operator: they are declared in the operator's realm
 * (Max-Health-Inc/proxy-smart-infra) and the beta deploy applies that declaration. A payload
 * written into this repository's deploy script is a second copy, and the copy that overwrote
 * the declaration on every deploy is how beta's Max Health login broke with a production
 * client id.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const repo = join(import.meta.dir, '../..')
const script = readFileSync(join(repo, '.github/scripts/deploy-beta-remote.sh'), 'utf8')
const workflow = readFileSync(join(repo, '.github/workflows/deploy-beta.yml'), 'utf8')

describe('beta login identity providers', () => {
  it('are applied from the realm declaration, never from a payload in this repository', () => {
    const writes = script.match(/-X (PUT|POST) "\$\{IDP_API\}[^"]*"[\s\S]*?\n(?=\s*(?:\)|HTTP_CODE|\[))/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) expect(write).toContain('--data-binary "@${IDP_FILE}"')
    expect(script).not.toMatch(/"providerId":\s*"oidc"/)
  })

  it("come from the beta realm in the operator's infrastructure, without the backend's hidden ones", () => {
    expect(workflow).toContain('repository: Max-Health-Inc/proxy-smart-infra')
    expect(workflow).toMatch(/select\(\.hideOnLogin != true and \.config\.hideOnLoginPage != "true"\)'\s+infra\/realm\/beta\/realm-export\.json/)
  })

  it("take the hosts beta must never broker to from the production realm's issuers", () => {
    expect(workflow).toContain('infra/realm/prod/realm-export.json | sort -u > realm-idps/production-hosts.txt')
    expect(script).not.toMatch(/FOREIGN_HOSTS='/)
  })
})
