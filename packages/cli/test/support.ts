// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, beforeEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs } from '../src/args'
import { createApiClient, type ApiClient } from '../src/client'
import { type CommandContext } from '../src/commands/shared'
import { type ResolvedConfig } from '../src/config'
import { Session } from '../src/session'

export const TEST_URL = 'https://proxy.example.com'

export function testConfig(homeDir: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { url: TEST_URL, clientId: 'admin-ui', scope: 'openid', homeDir, ...overrides }
}

export function useTempHome(prefix: string) {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    get dir(): string {
      return dir
    },
    config: (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => testConfig(dir, overrides),
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const failingFetch: typeof fetch = Object.assign(
  (): Promise<Response> => {
    throw new Error('network access is not allowed in this test')
  },
  { preconnect: fetch.preconnect },
)

export function captureStdout() {
  let written: string[] = []
  let restore = (): void => {}
  beforeEach(() => {
    written = []
    const spy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written.push(String(chunk))
      return true
    })
    restore = () => spy.mockRestore()
  })
  afterEach(() => restore())
  return { text: (): string => written.join('') }
}

type Surface = Exclude<keyof ApiClient, 'basePath'>

export interface RecordedCall {
  call: string
  args: unknown
}

export type ApiMocks = Partial<Record<Surface, Record<string, readonly [label: string, result: unknown]>>>

function isSurface(api: ApiClient, key: string): key is Surface {
  return key !== 'basePath' && key in api
}

export function createCommandContext(argv: string[], ...layers: ApiMocks[]) {
  const calls: RecordedCall[] = []
  const config = testConfig(join(tmpdir(), 'proxy-smart-cli-unused-home'))
  const session = new Session(config, failingFetch)
  const api = createApiClient(config, session)

  for (const layer of layers) {
    for (const [surface, methods] of Object.entries(layer)) {
      if (!isSurface(api, surface) || methods === undefined) continue
      for (const [method, [label, result]] of Object.entries(methods)) {
        Object.assign(api[surface], {
          [method]: mock(async (args?: unknown) => {
            calls.push({ call: label, args })
            return result
          }),
        })
      }
    }
  }

  const ctx: CommandContext = { args: parseArgs(argv), config, session, api }
  return { ctx, calls }
}
