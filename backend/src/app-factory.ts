// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { openapi, fromTypes } from '@elysiajs/openapi'
import { cors } from '@elysiajs/cors'
import { MCP_REQUEST_HEADERS, MCP_EXPOSED_RESPONSE_HEADERS } from '@proxy-smart/elysia-mcp'
import { isOriginAllowed, refreshIfStale } from './lib/cors-origins'
import staticPlugin from '@elysiajs/static'
import { join } from 'path'
import { keycloakPlugin } from './lib/keycloak-plugin'
import { fhirRoutes } from './routes/fhir'
import { statusRoutes } from './routes/status'
import { sourceRoutes } from './routes/source'
import { serverDiscoveryRoutes } from './routes/fhir-servers'
import {
  adminAuditMonitoringRoutes,
  authMonitoringRoutes,
  consentMonitoringRoutes,
  emailMonitoringRoutes,
  fhirMonitoringRoutes,
  fhirProxyMonitoringRoutes,
  oauthMonitoringRoutes,
} from './routes/monitoring'
import { oauthWebSocket } from './routes/oauth-websocket'
import { consentWebSocket } from './routes/consent-websocket'
import { fhirCapabilitiesRoutes } from './routes/fhir-capabilities'
import { config } from './config'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { mcpMetadataRoutes } from './routes/auth/mcp-metadata'
import { mcpEndpointRoutes } from './routes/mcp-endpoint'
import { fhirMcpRoutes } from './routes/fhir-mcp'
import { dicomwebRoutes } from './routes/dicomweb'
import { docsRoutes } from './routes/docs'
import { apiRoutes } from './routes/api'
import { brandBundleService } from './lib/brand-bundle'
import { getRuntimeBrandConfig } from './lib/runtime-config'
import { UserAccessBrandBundle } from './schemas'
import { discoverApps } from './lib/app-discovery'
import { serveDocs } from './lib/docs-files'
import { adminUiAbsentPage, notFoundDocument } from './web/status-pages'
import { landingResponse } from './web/landing'
import { appStoreResponse, type AppStoreQuery } from './web/app-store-page'
import { setDispatchApp } from './lib/ai/tool-registry'

const APP_STORE_QUERY = t.Object({
    size: t.Optional(t.String()),
    page: t.Optional(t.String()),
})

function serveAppStore(query: AppStoreQuery): Response {
    const { appStoreUrl } = getRuntimeBrandConfig()
    if (appStoreUrl) return Response.redirect(appStoreUrl, 302)
    return appStoreResponse(discoverApps(), query)
}

/**
 * Serve the bundled admin UI, or explain its absence.
 *
 * The UI is a separate build copied into public/webapp, so a deployment can ship
 * without it — the whole admin surface is reachable over the API and, since every
 * admin route is derived into an MCP tool, over /mcp as well. Returning the file
 * unconditionally turned that supported shape into an unexplained failure on a
 * path that simply is not there.
 */
async function serveAdminUi(): Promise<Response | ReturnType<typeof Bun.file>> {
    const index = Bun.file('public/webapp/index.html')
    if (await index.exists()) return index

    return adminUiAbsentPage()
}

/**
 * Elysia constructor options. Exported so the request-integrity test exercises the
 * real config — a test building its own Elysia would pass regardless.
 *
 * No `sanitize` here on purpose. It ran Bun.escapeHTML over every request-body
 * string (twice, since it escapes `&` too), corrupting inline JWKS, passwords and
 * URLs on ingest. Escaping belongs at HTML render, not at JSON ingest.
 */
export const ELYSIA_OPTIONS = {
    name: config.name,
    serve: {
        idleTimeout: 120
    },
    websocket: {
        idleTimeout: 120
    },
    aot: true,
} as const

export function createApp() {
    const app = new Elysia({ ...ELYSIA_OPTIONS })
        .use(cors({
            origin: (request: Request) => {
                // DICOMweb uses Bearer tokens, not cookies — safe to allow any origin.
                // Required for VS Code webviews, Electron apps, and embedded viewers.
                const path = new URL(request.url).pathname
                if (path.startsWith('/dicomweb')) return true

                // Trigger background refresh if cache is stale
                refreshIfStale()

                // All other routes: check against dynamic origins (env + Keycloak webOrigins)
                const from = request.headers.get('origin') || ''
                return isOriginAllowed(from)
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            // MCP header names come from the transport package rather than a literal
            // here, which is how Mcp-Method / Mcp-Name (required of clients since MCP
            // 2026-07-28) went missing from the allow-list.
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', ...MCP_REQUEST_HEADERS],
            // Without this the cors plugin echoes the REQUEST headers, so a
            // cross-origin client never sees Mcp-Session-Id on the initialize response
            // and re-initializes on every call. Content-Disposition is here for the
            // same reason — the monitoring dashboards read it to name CSV downloads.
            exposeHeaders: [...MCP_EXPOSED_RESPONSE_HEADERS, 'Content-Disposition'],
        }))
        .use(openapi({
            path: '/swagger',
            references: fromTypes(
                process.env.NODE_ENV === 'production' ? 'dist/index.d.ts' : 'src/index.ts',
                { projectRoot: join(import.meta.dir, '..') }
            ),
            documentation: {
                info: {
                    title: config.displayName,
                    version: config.version,
                    description: 'SMART on FHIR Proxy + Healthcare Administration API using Keycloak and Elysia',
                },
                tags: [
                    { name: 'authentication', description: 'Authentication and authorization endpoints' },
                    { name: 'users', description: 'Healthcare user management' },
                    { name: 'admin', description: 'Administrative operations' },
                    { name: 'fhir', description: 'FHIR resource proxy endpoints' },
                    { name: 'servers', description: 'FHIR server discovery endpoints' },
                    { name: 'identity-providers', description: 'Identity provider management' },
                    { name: 'smart-apps', description: 'SMART on FHIR configuration endpoints' },
                    { name: 'access-control', description: 'Physical access control (Kisi / UniFi Access)' },
                    { name: 'oauth-ws-monitoring', description: 'OAuth monitoring via WebSocket' },
                    { name: 'oauth-sse-monitoring', description: 'OAuth monitoring via Server-Sent Events' },
                    { name: 'ai', description: 'AI assistant endpoints with unified internal and MCP tools' },
                    { name: 'mcp-management', description: 'MCP server management endpoints' },
                    { name: 'mcp-endpoint', description: 'Built-in MCP Streamable HTTP server endpoint' },
                    { name: 'consent-monitoring', description: 'Consent decision monitoring and analytics' },
                    { name: 'fhir-monitoring', description: 'FHIR server uptime monitoring' },
                    { name: 'fhir-proxy-monitoring', description: 'FHIR proxy request metrics and error tracking' },
                    { name: 'admin-audit-monitoring', description: 'Admin action audit trail and analytics' },
                    { name: 'email-monitoring', description: 'Email event monitoring (password resets, verifications)' },
                    { name: 'auth-monitoring', description: 'Auth event monitoring (logins, logouts, registrations, token exchanges)' },
                    { name: 'dicomweb', description: 'DICOMweb proxy for WADO-RS and QIDO-RS imaging services' },
                    { name: 'shl', description: 'SMART Health Links for QR-based patient data sharing' },
                ],
                servers: [
                    { url: config.baseUrl, description: 'Development server' }
                ]
            }
        }))
        .use(staticPlugin({ 
            assets: 'public', 
            prefix: '/',
            alwaysStatic: true,
            indexHTML: false
        }))
        .get('/webapp', () => serveAdminUi())
        .get('/webapp/', () => serveAdminUi())
        .get('/', () => landingResponse(discoverApps()))
        // Browsers request /favicon.ico by default — redirect to our SVG icon
        .get('/favicon.ico', () => Response.redirect('/proxy-smart.svg', 301))
        // SMART apps directory
        .get('/apps.json', () => ({ apps: discoverApps() }))
        .get('/apps', ({ query }) => serveAppStore(query), { query: APP_STORE_QUERY })
        .get('/apps/', ({ query }) => serveAppStore(query), { query: APP_STORE_QUERY })
        // Patient Picker SPA fallback
        .get('/patient-picker', () => Bun.file('public/patient-picker/index.html'))
        .get('/patient-picker/', () => Bun.file('public/patient-picker/index.html'))
        .get('/patient-picker/*', () => Bun.file('public/patient-picker/index.html'))
        // SMART app SPA fallback (serves apps from public/apps/ on VPS beta deployments)
        .get('/apps/:app', ({ params }) => {
            const index = Bun.file(`public/apps/${params.app}/index.html`)
            return index.exists().then(exists => exists ? index : new Response('Not Found', { status: 404 }))
        })
        .get('/apps/:app/', ({ params }) => {
            const index = Bun.file(`public/apps/${params.app}/index.html`)
            return index.exists().then(exists => exists ? index : new Response('Not Found', { status: 404 }))
        })
        .get('/apps/:app/*', ({ params, path }) => {
            // Serve static assets directly if they exist, otherwise SPA fallback
            const staticFile = Bun.file(`public${path}`)
            const index = Bun.file(`public/apps/${params.app}/index.html`)
            return staticFile.exists().then(exists =>
                exists ? staticFile : index.exists().then(idxExists =>
                    idxExists ? index : new Response('Not Found', { status: 404 })
                )
            )
        })
        // User-Access Brand Bundle (SMART 2.2.0 Section 8)
        .get('/branding.json', async ({ set, headers }) => {
            const { bundle, etag } = await brandBundleService.getBrandBundle()
            // Support conditional requests (ETag / If-None-Match)
            const ifNoneMatch = headers['if-none-match']
            if (ifNoneMatch && ifNoneMatch === etag) {
                set.status = 304
                return '' as unknown as typeof bundle
            }
            set.headers['etag'] = etag
            set.headers['cache-control'] = 'public, max-age=60'
            return bundle
        }, {
            response: { 200: UserAccessBrandBundle },
            detail: {
                summary: 'User-Access Brand Bundle',
                description: 'FHIR Bundle (collection) of Organization and Endpoint resources for User-Access Brands (SMART 2.2.0 Section 8)',
                tags: ['smart-apps']
            }
        })
        .get('/docs', () => serveDocs(''))
        .get('/docs/', () => serveDocs(''))
        .get('/docs/*', ({ params }) => serveDocs(params['*']))
        .use(keycloakPlugin)
        .use(docsRoutes)
        .use(mcpMetadataRoutes)
        .use(statusRoutes)
        .use(sourceRoutes)
        .use(serverDiscoveryRoutes)
        .use(authRoutes)
        .use(adminRoutes)
        .use(apiRoutes)
        .use(oauthMonitoringRoutes)
        .use(oauthWebSocket)
        .use(consentMonitoringRoutes)
        .use(consentWebSocket)
        .use(fhirMonitoringRoutes)
        .use(fhirProxyMonitoringRoutes)
        .use(fhirCapabilitiesRoutes)
        .use(adminAuditMonitoringRoutes)
        .use(emailMonitoringRoutes)
        .use(authMonitoringRoutes)
        .use(mcpEndpointRoutes)
        .use(fhirMcpRoutes)
        .use(dicomwebRoutes)
        .use(fhirRoutes)
        .onError(({ code, set, request }) => {
            if (code === 'NOT_FOUND') {
                const accept = request.headers.get('accept') ?? ''
                // Return JSON for API clients
                if (accept.includes('application/json') && !accept.includes('text/html')) {
                    set.status = 404
                    return { error: 'Not Found', path: new URL(request.url).pathname }
                }
                // Return a styled HTML 404 page for browsers
                set.status = 404
                set.headers['content-type'] = 'text/html; charset=utf-8'
                return notFoundDocument(new URL(request.url).pathname)
            }
        })

    // Register the ROOT app for secure MCP / AI-chat tool dispatch. Tool and
    // resource execution is routed through `app.handle()` so guards,
    // response-schema coercion, and lifecycle hooks (e.g. admin audit logging)
    // all run — closing the synthetic-context middleware-bypass class.
    setDispatchApp(app)

    return app
}
