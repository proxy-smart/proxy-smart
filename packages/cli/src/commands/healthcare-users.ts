/** `proxy-smart healthcare-users <verb>`; update and federated identities go through `request`. */
import { CreateHealthcareUserRequestFromJSON } from '../api-client'
import { flagString } from '../args'
import { dataVerb, jsonVerb, listVerb, noTarget, positional, verbCommand } from './verbs/core'

const userId = positional('userId')

export const healthcareUsersCommand = verbCommand('healthcare-users', {
  list: listVerb({
    fetch: ({ api, args }) => {
      const limit = flagString(args.flags, 'limit')
      const offset = flagString(args.flags, 'offset')
      return api.healthcareUsers.getAdminHealthcareUsers({
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      })
    },
    rows: items => items,
  }),
  get: jsonVerb(userId, (api, id) => api.healthcareUsers.getAdminHealthcareUsersByUserId({ userId: id })),
  create: dataVerb(noTarget, (api, data) => api.healthcareUsers.postAdminHealthcareUsers({
    createHealthcareUserRequest: CreateHealthcareUserRequestFromJSON(data),
  })),
  delete: jsonVerb(userId, (api, id) => api.healthcareUsers.deleteAdminHealthcareUsersByUserId({ userId: id })),
})
