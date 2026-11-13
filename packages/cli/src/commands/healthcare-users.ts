// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** `proxy-smart healthcare-users <verb>`; update and federated identities go through `request`. */
import { CreateHealthcareUserRequestFromJSON } from '../api-client'
import { flagString } from '../args'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verb, verbCommand } from './verbs/core'

const userId = positional('userId')
const USER = '<userId>'

export const healthcareUsersCommand = verbCommand('healthcare-users', {
  list: verb(listVerb({
    fetch: ({ api, args }) => {
      const limit = flagString(args.flags, 'limit')
      const offset = flagString(args.flags, 'offset')
      return api.healthcareUsers.getAdminHealthcareUsers({
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      })
    },
    rows: items => items,
  }), '[--limit <n>] [--offset <n>]'),
  get: verb(jsonVerb(userId, (api, id) => api.healthcareUsers.getAdminHealthcareUsersByUserId({ userId: id })), USER),
  create: verb(dataVerb(noTarget, (api, data) => api.healthcareUsers.postAdminHealthcareUsers({
    createHealthcareUserRequest: CreateHealthcareUserRequestFromJSON(data),
  }))),
  delete: verb(jsonVerb(userId, (api, id) => api.healthcareUsers.deleteAdminHealthcareUsersByUserId({ userId: id })), USER),
})
