// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { type ApiClient } from '../../client'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verb, type ListSpec, type Verb } from './core'

export interface CrudSpec<TListed, TRow extends object> {
  key: string
  list: ListSpec<TListed, TRow>
  listArgs?: string
  get: (api: ApiClient, id: string) => Promise<unknown>
  create: (api: ApiClient, data: unknown) => Promise<unknown>
  update: (api: ApiClient, data: unknown, id: string) => Promise<unknown>
  remove: (api: ApiClient, id: string) => Promise<unknown>
  confirmRemove?: (id: string) => string
}

export interface CrudVerbs {
  list: Verb
  get: Verb
  create: Verb
  update: Verb
  delete: Verb
}

export function crudVerbs<TListed, TRow extends object>(spec: CrudSpec<TListed, TRow>): CrudVerbs {
  const id = positional(spec.key)
  const key = `<${spec.key}>`
  return {
    list: verb(listVerb(spec.list), spec.listArgs),
    get: verb(jsonVerb(id, spec.get), key),
    create: verb(dataVerb(noTarget, spec.create)),
    update: verb(dataVerb(id, spec.update), key),
    delete: verb(jsonVerb(id, spec.remove, spec.confirmRemove), spec.confirmRemove ? `${key} --yes` : key),
  }
}
