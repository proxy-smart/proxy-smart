// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterAll, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { adminAuditPlugin } from '../src/lib/admin-audit-middleware'
import { adminAuditLogger } from '../src/lib/admin-audit-logger'

const logSpy = spyOn(adminAuditLogger, 'log').mockImplementation(async () => {})
afterAll(() => logSpy.mockRestore())

const app = new Elysia().use(
  new Elysia({ prefix: '/admin' })
    .use(adminAuditPlugin)
    .post('/shutdown', () => ({ ok: true }))
    .post('/widgets', () => ({ ok: true })),
)

async function auditedAction(path: string): Promise<string | undefined> {
  await app.handle(new Request(`http://localhost${path}`, { method: 'POST' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  return logSpy.mock.calls.map(([event]) => event).filter((event) => event.path === path).pop()?.action
}

describe.serial('admin audit action classification', () => {
  it('records a server control POST as an action', async () => {
    expect(await auditedAction('/admin/shutdown')).toBe('action')
  })

  it('records a POST to a collection as a create', async () => {
    expect(await auditedAction('/admin/widgets')).toBe('create')
  })
})
