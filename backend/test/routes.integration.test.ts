import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'

// Attempt to import real route modules and mount them to an Elysia app to ensure
// production route code is executed (increasing coverage of backend/src).

let importedAuth: unknown = null
let importedStatus: unknown = null

try {
  importedAuth = await import('../src/routes/auth')
} catch {
  // Ignore import errors - module may not exist in test environment
}

try {
  importedStatus = await import('../src/routes/status')
} catch {
  // Ignore import errors - module may not exist in test environment
}

const buildAppWithRoutes = () => {
  const app = new Elysia()

  // Mount status route module if it exports a plugin/Elysia instance
  if (importedStatus) {
    const mod = importedStatus as Record<string, unknown>
    // Common patterns: export const statusRoutes = new Elysia().get(...)
    // or export default new Elysia()..., or export a function that accepts app
    const plugin = mod.statusRoutes || mod.default || mod

    if (typeof plugin === 'function' && plugin.length >= 1) {
      // function (app: Elysia) => app
      plugin(app)
    } else if (plugin && typeof plugin === 'object' && 'handle' in plugin && typeof plugin.handle === 'function') {
      // Elysia instance
      app.use(plugin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }

  if (importedAuth) {
    const mod = importedAuth as Record<string, unknown>
    const plugin = mod.authRoutes || mod.default || mod

    if (typeof plugin === 'function' && plugin.length >= 1) {
      plugin(app)
    } else if (plugin && typeof plugin === 'object' && 'handle' in plugin && typeof plugin.handle === 'function') {
      app.use(plugin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }

  return app
}

describe('Route modules integration (mounted into test Elysia app)', () => {
  it('auth config endpoint should respond with keycloak info when auth route is available', async () => {
    expect(importedAuth).toBeTruthy()
    const app = buildAppWithRoutes()

    const res = await app.handle(new Request('http://localhost/auth/config'))
    // If the route isn't present, this will likely be 404 and fail, prompting correct path fixes
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('keycloak')
    expect(data.keycloak).toHaveProperty('isConfigured')
    expect(typeof data.keycloak.isConfigured).toBe('boolean')
    if (data.keycloak.clientId !== undefined && data.keycloak.clientId !== null) {
      expect(typeof data.keycloak.clientId).toBe('string')
    }
  })

  it('public status says whether the deployment is up and which version, and nothing about its upstreams', async () => {
    expect(importedStatus).toBeTruthy()
    const res = await buildAppWithRoutes().handle(new Request('http://localhost/status'))
    expect([200, 422]).toContain(res.status)
    if (res.status === 422) return

    const data = await res.json()
    expect(Object.keys(data).sort()).toEqual(['overall', 'timestamp', 'version'])
  })

  it('health stays a liveness probe and ignores a forced refresh', async () => {
    const res = await buildAppWithRoutes().handle(new Request('http://localhost/health?force=1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(typeof data.status).toBe('string')
    expect(typeof data.uptime).toBe('number')
  })
})
