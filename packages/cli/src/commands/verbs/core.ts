// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { flagList, type ParsedArgs } from '../../args'
import { type ApiClient } from '../../client'
import { CliError, printJson, printTable } from '../../output'
import {
  requireConfirmation,
  requireJsonData,
  requirePositional,
  type CommandContext,
  type CommandHandler,
} from '../shared'

export type Target<T> = (args: ParsedArgs) => T

export const noTarget: Target<void> = () => undefined

export function positional(name: string, index = 2): Target<string> {
  return args => requirePositional(args, index, name)
}

export function verbCommand(
  command: string,
  handlers: Record<string, CommandHandler>,
  defaultVerb = 'list',
): CommandHandler {
  const verbs = new Map(Object.entries(handlers))
  return async ctx => {
    const verb = ctx.args.positionals[1] ?? defaultVerb
    const handler = verbs.get(verb)
    if (handler === undefined) {
      throw new CliError(`Unknown ${command} verb "${verb}". Use: ${[...verbs.keys()].join(' | ')}.`)
    }
    await handler(ctx)
  }
}

export function jsonVerb<T>(
  target: Target<T>,
  call: (api: ApiClient, target: T) => Promise<unknown>,
  confirm?: (target: T) => string,
): CommandHandler {
  return async ctx => {
    const resolved = target(ctx.args)
    if (confirm !== undefined) requireConfirmation(ctx, confirm(resolved))
    printJson(await call(ctx.api, resolved))
  }
}

export function dataVerb<T>(
  target: Target<T>,
  call: (api: ApiClient, data: unknown, target: T) => Promise<unknown>,
): CommandHandler {
  return async ctx => {
    const resolved = target(ctx.args)
    printJson(await call(ctx.api, requireJsonData(ctx.args), resolved))
  }
}

export interface ListSpec<TListed, TRow extends object> {
  fetch: (ctx: CommandContext) => Promise<TListed>
  rows: (listed: TListed) => readonly TRow[]
  check?: (ctx: CommandContext, rows: readonly TRow[], listed: TListed) => void
}

export function listVerb<TListed, TRow extends object>(spec: ListSpec<TListed, TRow>): CommandHandler {
  return async ctx => {
    const listed = await spec.fetch(ctx)
    if (ctx.args.flags.json === true) {
      printJson(listed)
      return
    }
    const rows = spec.rows(listed)
    printTable(rows, flagList(ctx.args.flags, 'columns'))
    spec.check?.(ctx, rows, listed)
  }
}

export function nestedListVerb<TItem, TRow extends object>(
  parent: string,
  list: (api: ApiClient, parentId: string) => Promise<readonly TItem[]>,
  row: (item: TItem) => TRow,
  check?: (ctx: CommandContext, rows: readonly TRow[]) => void,
): CommandHandler {
  const parentId = positional(parent)
  return listVerb({
    fetch: ctx => list(ctx.api, parentId(ctx.args)),
    rows: items => items.map(row),
    check,
  })
}
