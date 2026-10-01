/** Shared helpers for command handlers: request bodies, positionals and --yes gates. */
import { readFileSync } from 'fs'
import { type ParsedArgs, flagBool, flagString } from '../args'
import { CliError } from '../output'
import { type ApiClient } from '../client'
import { type Session } from '../session'
import { type ResolvedConfig } from '../config'

/** Context handed to every command handler. */
export interface CommandContext {
  args: ParsedArgs
  config: ResolvedConfig
  session: Session
  api: ApiClient
}

/** A command handler resolves once the command has fully run. */
export type CommandHandler = (ctx: CommandContext) => Promise<void>

/** Read `--data` as JSON: inline, `@file.json`, or `-` for stdin. Undefined when absent. */
export function readJsonData(args: ParsedArgs): unknown {
  const raw = flagString(args.flags, 'data')
  if (raw === undefined) return undefined

  let text: string
  if (raw === '-') {
    text = readFileSync(0, 'utf-8')
  } else if (raw.startsWith('@')) {
    text = readFileSync(raw.slice(1), 'utf-8')
  } else {
    text = raw
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`--data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Like readJsonData, but errors when no body was provided. */
export function requireJsonData(args: ParsedArgs): unknown {
  const data = readJsonData(args)
  if (data === undefined) {
    throw new CliError('This command requires a request body. Provide one with --data \'<json>\', --data @file.json, or --data -.')
  }
  return data
}

/** Pull the required positional at `index` (of the whole positionals array). */
export function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index]
  if (value === undefined) {
    throw new CliError(`Missing required argument <${name}>.`)
  }
  return value
}

export function requireConfirmation(ctx: CommandContext, refusal: string): void {
  if (!flagBool(ctx.args.flags, 'yes')) {
    throw new CliError(refusal)
  }
}
