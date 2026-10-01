/** `proxy-smart mcp-endpoint <verb>`: inspect the /mcp endpoint, or PATCH its config. */
import { PatchAdminMcpEndpointRequestFromJSON } from '../api-client'
import { dataVerb, jsonVerb, noTarget, verbCommand } from './verbs/core'

export const mcpEndpointCommand = verbCommand('mcp-endpoint', {
  get: jsonVerb(noTarget, api => api.mcp.getAdminMcpEndpoint()),
  update: dataVerb(noTarget, (api, data) => api.mcp.patchAdminMcpEndpoint({
    patchAdminMcpEndpointRequest: PatchAdminMcpEndpointRequestFromJSON(data),
  })),
}, 'get')
