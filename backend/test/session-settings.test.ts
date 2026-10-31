import { describe, it, expect } from 'bun:test'
import { validateSessionSettings } from '../src/lib/session-settings'

const VALID = {
  ssoSessionIdleTimeout: 1800,
  ssoSessionMaxLifespan: 36000,
  offlineSessionIdleTimeout: 2592000,
  offlineSessionMaxLifespan: 5184000,
  offlineSessionMaxLifespanEnabled: true,
}

describe('validateSessionSettings', () => {
  it('accepts the realm defaults', () => {
    expect(validateSessionSettings(VALID)).toBeUndefined()
  })

  it('accepts a partial update, so one field can change alone', () => {
    expect(validateSessionSettings({ offlineSessionMaxLifespanEnabled: true })).toBeUndefined()
  })

  it('rejects a max lifespan below its idle timeout', () => {
    expect(validateSessionSettings({ ...VALID, ssoSessionMaxLifespan: 60 })).toMatch(/ssoSessionMaxLifespan/)
    expect(
      validateSessionSettings({ ...VALID, offlineSessionMaxLifespan: 60 }),
    ).toMatch(/offlineSessionMaxLifespan/)
  })

  it('rejects a zero or negative lifetime', () => {
    // Keycloak treats zero as unlimited.
    expect(validateSessionSettings({ offlineSessionMaxLifespan: 0 })).toBeDefined()
    expect(validateSessionSettings({ ssoSessionIdleTimeout: -1 })).toBeDefined()
  })

  it('rejects enabling the ceiling without one being set anywhere', () => {
    expect(
      validateSessionSettings({ offlineSessionMaxLifespanEnabled: true, offlineSessionMaxLifespan: 0 }),
    ).toBeDefined()
  })

  it('rejects a non-integer, since Keycloak stores whole seconds', () => {
    expect(validateSessionSettings({ ssoSessionIdleTimeout: 12.5 })).toBeDefined()
  })

  it('ignores fields it does not own', () => {
    expect(validateSessionSettings({ displayName: 'hacked' } as never)).toBeUndefined()
  })
})
