// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Help + version text for the CLI.
 *
 * Kept in one module so the usage string stays the single source of truth for
 * the documented command surface.
 */
import pkg from '../package.json' with { type: 'json' }
import { printLine } from './output'

/** The CLI version, sourced from package.json (single source of truth). */
export const VERSION: string = pkg.version

/** Print the version string. */
export function printVersion(): void {
  printLine(VERSION)
}

/** Print the top-level usage / help text. */
export function printHelp(): void {
  printLine(`proxy-smart — admin CLI for the proxy-smart SMART on FHIR proxy

USAGE
  proxy-smart [global flags] <command> [subcommand] [args] [flags]

GLOBAL FLAGS
  --url <url>             Proxy base URL — the authorization server the CLI
                          authenticates through (env: PROXY_SMART_URL) [required]
  --client-id <id>        OAuth client id (env: PROXY_SMART_CLIENT_ID)
  --client-secret <s>     OAuth client secret (env: PROXY_SMART_CLIENT_SECRET)
  --scope <scopes>        Requested OAuth scopes (env: PROXY_SMART_SCOPE)
  --json                  Emit JSON instead of tables where applicable
  -h, --help              Show help
  -v, --version           Show version

AUTH
  login                   Sign in (device flow; client_credentials when a
                          secret is set or --ci is passed)
  logout                  Remove the cached token
  whoami                  Show the identity behind the cached token

GENERIC
  request <METHOD> <path> [--data <json>]
                          Send a bearer-authed request to any proxy path

DOMAINS
  smart-apps        list | get <clientId> | create | update <clientId> | delete <clientId>
                    mappers <clientId> | create-mapper <clientId>
                    update-mapper <clientId> <mapperId> | delete-mapper <clientId> <mapperId>
                    add-audience <clientId> <audience> [--name <n>] [--id-token]
  roles             list [--include-technical] | get <name> | create
                    update <name> | delete <name> --yes
                    client-roles <clientId> | client-get <clientId> <name>
                    client-create <clientId> | client-update <clientId> <name>
                    client-delete <clientId> <name> --yes
  healthcare-users  list | get <userId> | create | delete <userId>
  scope-sets        list | get <id> | create | delete <id>
  smart-scopes      list | create | batch | delete <scopeId>
  mcp-endpoint      get | update
  idps              list | get <alias> | create | update <alias> | delete <alias>
                    mapper-status [alias] | mappers <alias> | mapper-types <alias>
                    fix-mappers <alias> [--required-only] | test-connection <alias>
                    create-mapper <alias> | update-mapper <alias> <mapperId>
                    delete-mapper <alias> <mapperId>
  user-federation   list | get <id> | create | update <id> | delete <id> --yes
                    sync <id> [--action triggerFullSync|triggerChangedUsersSync]
                    mappers <id> | mapper-types <id>
                    create-mapper <id> | update-mapper <id> <mapperId>
                    delete-mapper <id> <mapperId>

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
  shutdown --yes          Gracefully stop the proxy server
  restart  --yes          Restart the proxy server

REQUEST BODIES
  Provide JSON via:  --data '<json>'  |  --data @file.json  |  --data -  (stdin)

EXAMPLES
  proxy-smart login
  proxy-smart smart-apps list --json
  proxy-smart smart-apps create --data @app.json
  proxy-smart scope-sets create --data '{"name":"Reader","scopes":["patient/*.read"]}'
  proxy-smart smart-scopes list --smart-only
  proxy-smart smart-scopes batch --data '{"scopes":[{"name":"patient/Binary.cruds"},{"name":"patient/DocumentReference.cruds"}]}'
  proxy-smart smart-apps mappers patient-portal
  proxy-smart smart-apps add-audience patient-portal https://fhir.example.com/R4
  proxy-smart smart-apps create-mapper patient-portal --data '{"name":"fhirUser","protocolMapper":"oidc-usermodel-attribute-mapper","config":{"user.attribute":"fhirUser","claim.name":"fhirUser","access.token.claim":"true"}}'
  proxy-smart roles list
  proxy-smart roles create --data '{"name":"clinician","fhirScopes":["patient/*.read"]}'
  proxy-smart roles client-roles admin-ui
  proxy-smart idps mapper-status --strict
  proxy-smart idps fix-mappers hospital-oidc
  proxy-smart idps test-connection hospital-oidc
  proxy-smart idps create-mapper hospital-oidc --data '{"name":"npi-import","identityProviderMapper":"oidc-user-attribute-idp-mapper","config":{"claim":"npi","user.attribute":"npi"}}'
  proxy-smart user-federation mappers <id>
  proxy-smart request GET /admin/smart-config
  proxy-smart restart --yes

Config + token cache live under ~/.proxy-smart (override with PROXY_SMART_HOME).`)
}
