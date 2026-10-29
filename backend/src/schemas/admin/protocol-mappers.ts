// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

// Not re-modelled: valid config keys differ per mapper type and Keycloak is the authority.
export const ProtocolMapperConfig = t.Record(t.String(), t.String(), {
  description: 'Mapper configuration, as Keycloak stores it (flat string map, keys depend on the mapper type)'
})

export const ProtocolMapperResponse = t.Object({
  id: t.Optional(t.String({ description: 'Keycloak protocol mapper ID' })),
  name: t.Optional(t.String({ description: 'Mapper name (unique per client)' })),
  protocol: t.Optional(t.String({ description: 'Protocol the mapper applies to (openid-connect)' })),
  protocolMapper: t.Optional(t.String({ description: 'Mapper type, e.g. oidc-audience-mapper or oidc-usermodel-attribute-mapper' })),
  config: t.Optional(ProtocolMapperConfig)
}, { title: 'ProtocolMapperResponse' })

export const CreateProtocolMapperRequest = t.Object({
  name: t.String({ description: 'Mapper name (must be unique on the client)' }),
  protocolMapper: t.String({ description: 'Mapper type, e.g. oidc-audience-mapper' }),
  protocol: t.Optional(t.String({ description: 'Protocol the mapper applies to (default: openid-connect)' })),
  config: t.Optional(ProtocolMapperConfig)
}, { title: 'CreateProtocolMapperRequest' })

export const UpdateProtocolMapperRequest = t.Object({
  name: t.Optional(t.String({ description: 'New mapper name' })),
  /** Merged into the existing config, not replaced. */
  config: t.Optional(ProtocolMapperConfig)
}, { title: 'UpdateProtocolMapperRequest' })

export const AddAudienceMapperRequest = t.Object({
  audience: t.String({ description: 'Client id of a realm client, or a literal audience URL' }),
  name: t.Optional(t.String({ description: 'Mapper name (default: "<audience>-audience")' })),
  includeInIdToken: t.Optional(t.Boolean({ description: 'Also emit the audience in the ID token (default: false)' }))
}, { title: 'AddAudienceMapperRequest' })

export const AddAudienceMapperResponse = t.Object({
  created: t.Boolean({ description: 'False when a mapper for this audience already existed (the call is idempotent)' }),
  resolvedAs: t.UnionEnum(['client', 'custom'], {
    description: 'Whether the audience resolved to a realm client (included.client.audience) or a literal value (included.custom.audience)'
  }),
  mapper: ProtocolMapperResponse
}, { title: 'AddAudienceMapperResponse' })

export type ProtocolMapperResponseType = Static<typeof ProtocolMapperResponse>
export type CreateProtocolMapperRequestType = Static<typeof CreateProtocolMapperRequest>
export type UpdateProtocolMapperRequestType = Static<typeof UpdateProtocolMapperRequest>
export type AddAudienceMapperRequestType = Static<typeof AddAudienceMapperRequest>
export type AddAudienceMapperResponseType = Static<typeof AddAudienceMapperResponse>
