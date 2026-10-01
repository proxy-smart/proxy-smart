// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { type ApiClient } from '../../client'
import { requirePositional, type CommandContext, type CommandHandler } from '../shared'
import { dataVerb, jsonVerb, nestedListVerb, positional, type Target } from './core'

export interface MapperRef {
  parentId: string
  mapperId: string
}

export interface MapperSpec<TMapper, TRow extends object> {
  parent: string
  list: (api: ApiClient, parentId: string) => Promise<readonly TMapper[]>
  row: (mapper: TMapper) => TRow
  check?: (ctx: CommandContext, rows: readonly TRow[]) => void
  create: (api: ApiClient, data: unknown, parentId: string) => Promise<unknown>
  update: (api: ApiClient, data: unknown, ref: MapperRef) => Promise<unknown>
  remove: (api: ApiClient, ref: MapperRef) => Promise<unknown>
}

export interface MapperVerbs {
  list: CommandHandler
  create: CommandHandler
  update: CommandHandler
  delete: CommandHandler
}

export function mapperVerbs<TMapper, TRow extends object>(spec: MapperSpec<TMapper, TRow>): MapperVerbs {
  const parentId = positional(spec.parent)
  const ref: Target<MapperRef> = args => ({
    parentId: parentId(args),
    mapperId: requirePositional(args, 3, 'mapperId'),
  })
  return {
    list: nestedListVerb(spec.parent, spec.list, spec.row, spec.check),
    create: dataVerb(parentId, spec.create),
    update: dataVerb(ref, spec.update),
    delete: jsonVerb(ref, spec.remove),
  }
}
