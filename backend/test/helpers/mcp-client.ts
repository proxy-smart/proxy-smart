// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  isCallToolResult,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  isSpecType,
  type CallToolResult,
  type JSONRPCMessage,
  type McpServer,
  type Tool,
} from '@modelcontextprotocol/server'
import { parseJson, requireRecord } from '../../src/lib/type-guards'

export interface McpTestClient {
  listTools(): Promise<Tool[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
}

/** A JSON-RPC client over an in-memory transport, so tools run through the real McpServer, schema validation included. */
export async function connectMcpClient(server: McpServer): Promise<McpTestClient> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 0

  client.onmessage = (message: JSONRPCMessage) => {
    if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) return
    if (typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (isJSONRPCResultResponse(message)) waiter?.resolve(message.result)
    else waiter?.reject(new Error(`${message.error.code}: ${message.error.message}`))
  }

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = ++nextId
    const answered = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
    return client.send({ jsonrpc: '2.0', id, method, params }).then(() => answered)
  }

  await server.connect(serverSide)
  await client.start()
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'proxy-smart-test', version: '0.0.0' },
  })
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    async listTools() {
      const result = await request('tools/list')
      if (!isSpecType.ListToolsResult(result)) throw new Error(`tools/list answered ${JSON.stringify(result)}`)
      return result.tools
    },
    async callTool(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args })
      if (!isCallToolResult(result)) throw new Error(`tools/call ${name} answered ${JSON.stringify(result)}`)
      return result
    },
  }
}

/** The text of a tool result's first content block; throws when it has none. */
export function toolText(result: CallToolResult): string {
  const [first] = result.content
  if (first?.type !== 'text') throw new Error(`tool result has no text block: ${JSON.stringify(result)}`)
  return first.text
}

/** A tool result's text parsed as a JSON object; throws on anything else. */
export function toolJson(result: CallToolResult): Record<string, unknown> {
  return requireRecord(parseJson(toolText(result)), 'tool result text')
}
