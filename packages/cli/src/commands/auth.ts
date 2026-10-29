import { flagBool } from '../args'
import { normalizeUrl, readPersistedConfig, writePersistedConfig } from '../config'
import { CliError, printJson, printLine } from '../output'
import { type CommandContext } from './shared'

/** Persist the login target so a bare next command does not fall back to localhost; best-effort. */
function rememberDeployment(ctx: CommandContext): void {
  try {
    writePersistedConfig(ctx.config.homeDir, { ...readPersistedConfig(ctx.config.homeDir), url: ctx.config.url })
  } catch {
    printLine(`Note: could not save ${ctx.config.url} as the default target — pass --url on later commands.`)
  }
  warnIfEnvOverrides(ctx)
}

/** Env outranks the persisted target, so a differing PROXY_SMART_URL would redirect the next bare command. */
function warnIfEnvOverrides(ctx: CommandContext): void {
  const fromEnv = process.env.PROXY_SMART_URL
  if (!fromEnv || normalizeUrl(fromEnv) === ctx.config.url) return
  printLine('')
  printLine(`Warning: PROXY_SMART_URL is set to ${normalizeUrl(fromEnv)}, which is NOT where you just`)
  printLine(`signed in. Commands without --url will target that instead and be refused. Either:`)
  printLine(`  proxy-smart --url ${ctx.config.url} <command>`)
  printLine(`  $env:PROXY_SMART_URL = '${ctx.config.url}'    # or unset it`)
}

export async function loginCommand(ctx: CommandContext): Promise<void> {
  const useClientCredentials = flagBool(ctx.args.flags, 'ci') || Boolean(ctx.config.clientSecret)

  if (useClientCredentials) {
    if (!ctx.config.clientSecret) {
      throw new CliError('client_credentials login requires a client secret (PROXY_SMART_CLIENT_SECRET or --client-secret).')
    }
    await ctx.session.loginWithClientCredentials()
    rememberDeployment(ctx)
    printLine(`Authenticated to ${ctx.config.url} via client_credentials as "${ctx.config.clientId}".`)
    return
  }

  await ctx.session.loginWithDeviceFlow((device) => {
    printLine('')
    printLine('To sign in, open the following URL in your browser:')
    printLine(`  ${device.verification_uri_complete ?? device.verification_uri}`)
    if (!device.verification_uri_complete) {
      printLine('')
      printLine(`And enter the code:  ${device.user_code}`)
    }
    printLine('')
    printLine('Waiting for authorization...')
  })
  rememberDeployment(ctx)
  printLine(`Authenticated to ${ctx.config.url} as "${ctx.config.clientId}".`)
}

export async function logoutCommand(ctx: CommandContext): Promise<void> {
  ctx.session.logout()
  printLine('Logged out. Cached token removed.')
}

export async function whoamiCommand(ctx: CommandContext): Promise<void> {
  const token = await ctx.session.getAccessToken()
  const res = await fetch(`${ctx.config.url}/auth/userinfo`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (!res.ok) {
    throw new CliError(`Failed to fetch identity (HTTP ${res.status}). The token may be expired — try \`proxy-smart login\`.`)
  }
  printJson(await res.json())
}
