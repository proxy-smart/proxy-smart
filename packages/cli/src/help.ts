// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import pkg from '../package.json' with { type: 'json' }
import { printLine } from './output'
import { DEFAULT_HOME_DIR, ENV, SETTINGS } from './config'
import { type DomainCommand } from './commands/verbs/core'

export const VERSION: string = pkg.version

export function printVersion(): void {
  printLine(VERSION)
}

const WIDTH = 92
const FLAG_COLUMN = 26
const DOMAIN_COLUMN = 20

function pack(parts: readonly string[], separator: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const part of parts) {
    const next = current ? `${current}${separator}${part}` : part
    if (current && next.length > width) {
      lines.push(current)
      current = part
    } else {
      current = next
    }
  }
  return current ? [...lines, current] : lines
}

function indented(head: string, body: readonly string[], column: number): string {
  const pad = ' '.repeat(column)
  const lines = body.map(line => `${pad}${line}`)
  if (head.length >= column - 2) return [`  ${head}`, ...lines].join('\n')
  return [`  ${head.padEnd(column - 2)}${body[0] ?? ''}`, ...lines.slice(1)].join('\n')
}

function columns(left: string, right: string, column = FLAG_COLUMN): string {
  return indented(left, pack(right.split(' '), ' ', WIDTH - column), column)
}

function settingLines(): string[] {
  return SETTINGS.flatMap(setting => {
    if (!setting.flag) return []
    const fallback = setting.fallback ? `, default ${setting.fallback}` : ''
    return [columns(`${setting.flag} ${setting.placeholder ?? ''}`.trim(), `${setting.summary} (env: ${setting.env}${fallback})`)]
  })
}

function domainLines(domain: DomainCommand): string {
  const verbs = domain.usage.map(({ verb, args }) => (args ? `${verb} ${args}` : verb))
  return indented(domain.command, pack(verbs, ' | ', WIDTH - DOMAIN_COLUMN), DOMAIN_COLUMN)
}

export function helpText(domains: readonly DomainCommand[]): string {
  return `proxy-smart — admin CLI for the proxy-smart SMART on FHIR proxy

USAGE
  proxy-smart [global flags] <command> [subcommand] [args] [flags]

GLOBAL FLAGS
${settingLines().join('\n')}
${columns('--json', 'Emit JSON instead of tables where applicable')}
${columns('-h, --help', 'Show help')}
${columns('-v, --version', 'Show version')}

AUTH
${columns('login [--ci]', 'Sign in (device flow; client_credentials when a secret is set or --ci is passed)')}
${columns('logout', 'Remove the cached token')}
${columns('whoami', 'Show the identity behind the cached token')}

GENERIC
${columns('request <METHOD> <path> [--data <json>]', 'Send a bearer-authed request to any proxy path')}

DOMAINS
${domains.map(domainLines).join('\n')}

TOKEN AUDIENCE
  The proxy validates the access-token audience fail-closed, so a client whose
  tokens carry the wrong aud cannot launch. add-audience writes the audience
  mapper for you and picks the right Keycloak config key for a realm client id
  versus a literal URL. It is idempotent, so it is safe to run from a deploy:

  proxy-smart smart-apps add-audience patient-portal fhir-resource-server
  proxy-smart smart-apps mappers patient-portal

CLAIM MAPPING CHECKS
  Brokered and directory users only carry the attributes a mapper imports for
  them, and a user without fhirUser cannot be launched into a SMART app. Add
  --strict to fail (exit 1) when an import is missing, so these work as CI gates:

  proxy-smart idps mapper-status --strict
  proxy-smart user-federation mappers <id> --strict

LIST OUTPUT
  By default, list renders an aligned table whose columns are derived from the
  returned data (the first few scalar fields). Override the columns with
  --columns <a,b,c>, or use --json to emit the full objects.

SERVER OPS
${columns('shutdown --yes', 'Gracefully stop the proxy server')}
${columns('restart --yes', 'Restart the proxy server')}

REQUEST BODIES
  Provide JSON via:  --data '<json>'  |  --data @file.json  |  --data -  (stdin)

EXAMPLES
  proxy-smart login
  proxy-smart smart-apps list --json
  proxy-smart smart-apps create --data @app.json
  proxy-smart scope-sets create --data '{"name":"Reader","scopes":["patient/*.read"]}'
  proxy-smart smart-scopes list --smart-only
  proxy-smart smart-scopes batch --data '{"scopes":[{"name":"patient/Binary.cruds"},{"name":"patient/DocumentReference.cruds"}]}'
  proxy-smart smart-apps add-audience patient-portal https://fhir.example.com/R4
  proxy-smart smart-apps create-mapper patient-portal --data '{"name":"fhirUser","protocolMapper":"oidc-usermodel-attribute-mapper","config":{"user.attribute":"fhirUser","claim.name":"fhirUser","access.token.claim":"true"}}'
  proxy-smart roles create --data '{"name":"clinician","fhirScopes":["patient/*.read"]}'
  proxy-smart roles client-roles admin-ui
  proxy-smart healthcare-users list --limit 50
  proxy-smart mcp-endpoint update --data '{"disabledTools":["delete_admin_smart-apps_clientId"]}'
  proxy-smart idps fix-mappers hospital-oidc
  proxy-smart idps test-connection hospital-oidc
  proxy-smart idps create-mapper hospital-oidc --data '{"name":"npi-import","identityProviderMapper":"oidc-user-attribute-idp-mapper","config":{"claim":"npi","user.attribute":"npi"}}'
  proxy-smart request GET /admin/status
  proxy-smart restart --yes

Config and token cache live under ${DEFAULT_HOME_DIR} (override with ${ENV.home}).`
}

export function printHelp(domains: readonly DomainCommand[]): void {
  printLine(helpText(domains))
}
