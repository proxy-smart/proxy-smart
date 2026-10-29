// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// `proxy-smart login` needs the device grant; `--import-realm` is IGNORE_EXISTING, so only the runtime reconcile sets it.
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel } from './helpers/realm-exports'
import { ensureAdminUiDeviceGrant } from '@/lib/kc-system-provisioning'
import { fakeKcAdmin } from './helpers/keycloak-admin'

const DEVICE_GRANT_ATTR = 'oauth2.device.authorization.grant.enabled'

/** Keycloak holding the admin-ui client with `attributes`, or no such client when null. */
function withAdminUi(attributes: Record<string, string> | null) {
  return fakeKcAdmin({ clients: attributes === null ? [] : [{ id: 'internal-uuid', clientId: 'admin-ui', attributes }] })
}

describe('every realm export declares the attribute', () => {
  for (const path of realmExportPaths()) {
    it(`${realmExportLabel(path)} sets it on admin-ui`, () => {
      const realm = readRealmExport(path)
      const adminUi = (realm.clients ?? []).find((c) => c.clientId === 'admin-ui')
      expect(adminUi?.attributes?.[DEVICE_GRANT_ATTR]).toBe('true')
    })
  }
})

describe('ensureAdminUiDeviceGrant', () => {
  it('enables the grant when the live client has it disabled', async () => {
    const kc = withAdminUi({ [DEVICE_GRANT_ATTR]: 'false', 'pkce.code.challenge.method': 'S256' })
    await ensureAdminUiDeviceGrant(kc.admin)

    expect(kc.updated).toHaveLength(1)
    expect(kc.updated[0].payload.attributes?.[DEVICE_GRANT_ATTR]).toBe('true')
    expect(kc.updated[0].payload.attributes?.['pkce.code.challenge.method']).toBe('S256')
  })

  it('enables the grant when the attribute is absent entirely', async () => {
    const kc = withAdminUi({})
    await ensureAdminUiDeviceGrant(kc.admin)

    expect(kc.updated).toHaveLength(1)
    expect(kc.updated[0].payload.attributes?.[DEVICE_GRANT_ATTR]).toBe('true')
  })

  it('writes nothing when it is already enabled', async () => {
    const kc = withAdminUi({ [DEVICE_GRANT_ATTR]: 'true' })
    await ensureAdminUiDeviceGrant(kc.admin)

    expect(kc.updated).toHaveLength(0)
  })

  it('does nothing when the client does not exist', async () => {
    const kc = withAdminUi(null)
    await ensureAdminUiDeviceGrant(kc.admin)

    expect(kc.updated).toHaveLength(0)
  })

  it('never throws — a failed reconcile must not stop the server booting', async () => {
    const { admin } = fakeKcAdmin()
    admin.clients.find = async () => { throw new Error('Keycloak unreachable') }
    expect(ensureAdminUiDeviceGrant(admin)).resolves.toBeUndefined()
  })
})
