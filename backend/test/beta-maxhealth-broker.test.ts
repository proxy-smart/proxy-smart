/**
 * The beta deploy PUTs the whole `maxhealth` identity provider on every run, so its
 * payload, not anything set by hand, is what beta brokers with. auth.beta.maxhealth.tech
 * registers beta's broker as `proxy-smart-beta` with private_key_jwt; `proxy-smart` is
 * production's client and only allows production's broker callback.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const script = readFileSync(join(import.meta.dir, '../../.github/scripts/deploy-beta-remote.sh'), 'utf8')

function maxhealthPayload(): { alias: string; config: Record<string, string> } {
  const match = /MH_PAYLOAD=\$\(cat <<JSON\n([\s\S]*?)\nJSON\n/.exec(script)
  if (!match?.[1]) throw new Error('deploy-beta-remote.sh no longer declares MH_PAYLOAD')
  return JSON.parse(match[1].replaceAll('${MH_ISSUER}', 'https://auth.beta.maxhealth.tech'))
}

describe('the maxhealth broker the beta deploy reconciles', () => {
  it("presents beta's own client, authenticated with a signed assertion", () => {
    const { alias, config } = maxhealthPayload()
    expect(alias).toBe('maxhealth')
    expect(config.clientId).toBe('proxy-smart-beta')
    expect(config.clientAuthMethod).toBe('private_key_jwt')
  })

  it('brokers to the beta issuer only', () => {
    expect(maxhealthPayload().config.issuer).toBe('https://auth.beta.maxhealth.tech')
  })
})
