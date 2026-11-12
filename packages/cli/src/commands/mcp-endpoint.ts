// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** `proxy-smart mcp-endpoint <verb>`: inspect the /mcp endpoint, or PATCH its config. */
import { PatchAdminMcpEndpointRequestFromJSON } from '../api-client'
import { dataVerb, jsonVerb, noTarget, verb, verbCommand } from './verbs/core'

export const mcpEndpointCommand = verbCommand('mcp-endpoint', {
  get: verb(jsonVerb(noTarget, api => api.mcp.getAdminMcpEndpoint())),
  update: verb(dataVerb(noTarget, (api, data) => api.mcp.patchAdminMcpEndpoint({
    patchAdminMcpEndpointRequest: PatchAdminMcpEndpointRequestFromJSON(data),
  }))),
}, 'get')
