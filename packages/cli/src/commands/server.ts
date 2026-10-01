/** `proxy-smart shutdown` / `proxy-smart restart`: server lifecycle, gated behind --yes. */
import { type ApiClient } from '../client'
import { printJson } from '../output'
import { requireConfirmation, type CommandHandler } from './shared'

function lifecycleCommand(operation: string, call: (api: ApiClient) => Promise<unknown>): CommandHandler {
  return async ctx => {
    requireConfirmation(ctx, `Refusing to ${operation} ${ctx.config.url} without confirmation. Re-run with --yes.`)
    printJson(await call(ctx.api))
  }
}

export const shutdownCommand = lifecycleCommand('shutdown', api => api.admin.postAdminShutdown())

export const restartCommand = lifecycleCommand('restart', api => api.admin.postAdminRestart())
