// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseArgs, flagString, flagBool, type ParsedArgs } from './args'
import { resolveConfig, type ConfigOverrides } from './config'
import { Session } from './session'
import { createApiClient } from './client'
import { describeError, printError, CliError } from './output'
import { printHelp, printVersion } from './help'
import { type CommandContext, type CommandHandler } from './commands/shared'
import { loginCommand, logoutCommand, whoamiCommand } from './commands/auth'
import { requestCommand } from './commands/request'
import { smartAppsCommand } from './commands/smart-apps'
import { healthcareUsersCommand } from './commands/healthcare-users'
import { rolesCommand } from './commands/roles'
import { scopeSetsCommand } from './commands/scope-sets'
import { smartScopesCommand } from './commands/smart-scopes'
import { mcpEndpointCommand } from './commands/mcp-endpoint'
import { identityProvidersCommand } from './commands/identity-providers'
import { userFederationCommand } from './commands/user-federation'
import { shutdownCommand, restartCommand } from './commands/server'
import { type DomainCommand } from './commands/verbs/core'

export const DOMAIN_COMMANDS: readonly DomainCommand[] = [
  smartAppsCommand,
  rolesCommand,
  healthcareUsersCommand,
  scopeSetsCommand,
  smartScopesCommand,
  mcpEndpointCommand,
  identityProvidersCommand,
  userFederationCommand,
]

const COMMANDS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ['login', loginCommand],
  ['logout', logoutCommand],
  ['whoami', whoamiCommand],
  ['request', requestCommand],
  ...DOMAIN_COMMANDS.map((domain): [string, CommandHandler] => [domain.command, domain]),
  ['shutdown', shutdownCommand],
  ['restart', restartCommand],
])

/** Map kebab-case global flags onto config overrides. Pure. */
export function overridesFromFlags(flags: ParsedArgs['flags']): ConfigOverrides {
  return {
    url: flagString(flags, 'url'),
    clientId: flagString(flags, 'client-id'),
    clientSecret: flagString(flags, 'client-secret'),
    scope: flagString(flags, 'scope'),
  }
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args.positionals[0]

  if (flagBool(args.flags, 'version') || command === 'version') {
    printVersion()
    return 0
  }
  if (flagBool(args.flags, 'help') || command === 'help' || command === undefined) {
    printHelp(DOMAIN_COMMANDS)
    return 0
  }

  const handler = COMMANDS.get(command)
  if (!handler) {
    printError(`Unknown command "${command}". Run \`proxy-smart --help\` for usage.`)
    return 1
  }

  const config = resolveConfig(overridesFromFlags(args.flags))
  const session = new Session(config)
  const api = createApiClient(config, session)
  const ctx: CommandContext = { args, config, session, api }

  try {
    await handler(ctx)
    return 0
  } catch (error) {
    printError(await describeError(error))
    return error instanceof CliError ? error.exitCode : 1
  }
}
