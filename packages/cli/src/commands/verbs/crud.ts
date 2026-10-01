// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { type ApiClient } from '../../client'
import { type CommandHandler } from '../shared'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, type ListSpec } from './core'

export interface CrudSpec<TListed, TRow extends object> {
  key: string
  list: ListSpec<TListed, TRow>
  get: (api: ApiClient, id: string) => Promise<unknown>
  create: (api: ApiClient, data: unknown) => Promise<unknown>
  update: (api: ApiClient, data: unknown, id: string) => Promise<unknown>
  remove: (api: ApiClient, id: string) => Promise<unknown>
  confirmRemove?: (id: string) => string
}

export interface CrudVerbs {
  list: CommandHandler
  get: CommandHandler
  create: CommandHandler
  update: CommandHandler
  delete: CommandHandler
}

export function crudVerbs<TListed, TRow extends object>(spec: CrudSpec<TListed, TRow>): CrudVerbs {
  const id = positional(spec.key)
  return {
    list: listVerb(spec.list),
    get: jsonVerb(id, spec.get),
    create: dataVerb(noTarget, spec.create),
    update: dataVerb(id, spec.update),
    delete: jsonVerb(id, spec.remove, spec.confirmRemove),
  }
}
