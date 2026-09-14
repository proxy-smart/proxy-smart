/**
 * GET /auth/login-brand.css — the per-organization accent the Keycloak login theme links.
 *
 * The login theme is static CSS, so this endpoint is the only thing that can resolve which
 * organization is launching. It is public (the login page is pre-auth) and its output is
 * interpolated into a stylesheet, so the two properties that matter are: it never emits a
 * value that could close the rule, and it degrades to nothing rather than erroring.
 *
 * Only the Keycloak admin client is mocked. With no admin client the resolver falls back to
 * the global brand, which `config.brand` reads from the environment on every access — so
 * these drive real colours through the real resolver, sanitiser and route.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'

const noop = () => {}
const noopCategory = { error: noop, warn: noop, info: noop, debug: noop, trace: noop }
const noopLogger = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop === 'string') {
      if (['error', 'warn', 'info', 'debug', 'trace'].includes(prop)) return noop
      return noopCategory
    }
    return undefined
  },
})
mock.module('@/lib/logger', () => ({
  logger: noopLogger,
  createLogger: () => noopLogger,
  PerformanceTimer: class { start() {} stop() { return 0 } },
  createRequestLogger: () => ({ request: noop, response: noop }),
}))
mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))
mock.module('cross-fetch', () => ({
  default: async () => new Response('{}', { status: 200 }),
}))
// No admin client: the per-org lookup is skipped and the global brand stands. Keeps these
// tests off the Keycloak admin API without stubbing the resolver itself.
// mock.module replaces the whole module, so every export the importers use has
// to be here — a missing one fails the import, not the assertion.
mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => null,
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

process.env.BASE_URL = 'http://localhost:8445'
process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
process.env.KEYCLOAK_REALM = 'smart-health'
process.env.SMART_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'

const { authRoutes } = await import('@/routes/auth')

function css(query: string) {
  return authRoutes.handle(new Request(`http://localhost:8445/auth/login-brand.css${query}`))
}

const originalPrimary = process.env.BRAND_PRIMARY_COLOR
const originalAccent = process.env.BRAND_ACCENT_COLOR

afterAll(() => {
  process.env.BRAND_PRIMARY_COLOR = originalPrimary
  process.env.BRAND_ACCENT_COLOR = originalAccent
})

describe('GET /auth/login-brand.css', () => {
  beforeEach(() => {
    delete process.env.BRAND_PRIMARY_COLOR
    delete process.env.BRAND_ACCENT_COLOR
  })

  it('serves the brand colour as a custom property', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#123456'
    const res = await css('?client_id=org-app')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(':root{--brand-accent:#123456}\n')
  })

  it('is served as CSS so a stylesheet link applies it', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#123456'
    expect((await css('?client_id=org-app')).headers.get('content-type')).toContain('text/css')
  })

  it('prefers an explicit accent over the primary colour', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#111111'
    process.env.BRAND_ACCENT_COLOR = '#eeeeee'
    expect(await (await css('?client_id=x')).text()).toBe(':root{--brand-accent:#eeeeee}\n')
  })

  it('emits nothing when no colour is configured, leaving the theme default', async () => {
    const res = await css('?client_id=x')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('refuses to emit a colour that would close the rule', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#000; } body { display: none } :root {'
    const body = await (await css('?client_id=x')).text()
    expect(body).toBe('')
    expect(body).not.toContain('display')
  })

  it('refuses a url() payload and falls back to the primary colour', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#00d294'
    process.env.BRAND_ACCENT_COLOR = 'url(https://evil.example/x)'
    expect(await (await css('?client_id=x')).text()).toBe(':root{--brand-accent:#00d294}\n')
  })

  it('answers without a client_id rather than erroring', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#123456'
    const res = await css('')
    expect(res.status).toBe(200)
  })

  it('is cacheable but only briefly, so a colour change lands without a redeploy', async () => {
    process.env.BRAND_PRIMARY_COLOR = '#123456'
    const cacheControl = (await css('?client_id=x')).headers.get('cache-control')
    expect(cacheControl).toContain('max-age')
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl ?? '')?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(300)
  })
})
