// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import type { Extension } from 'fhir/r4'

mockLoggerModule()

const { AdminConfigStore } = await import('../src/lib/admin-config-store')
const { BrandBundleService } = await import('../src/lib/brand-bundle')
type BrandConfigType = import('../src/schemas').BrandConfigType
type AdminConfigBackend = import('../src/lib/admin-config-store').AdminConfigBackend
type AdminConfigValue = import('../src/lib/admin-config-store').AdminConfigValue
type BrandServer = import('../src/lib/brand-resources').BrandServer
type BrandResource = import('../src/lib/brand-resources').BrandResource
type BrandBundle = import('../src/lib/brand-bundle').BrandBundle

class MemoryBackend implements AdminConfigBackend {
  readonly values = new Map<string, AdminConfigValue>()
  async load(key: string): Promise<AdminConfigValue | null> {
    return this.values.get(key) ?? null
  }
  async store(key: string, value: AdminConfigValue): Promise<void> {
    this.values.set(key, structuredClone(value))
  }
}

const BASE: BrandConfigType = {
  name: 'Acme Health',
  website: 'https://acme.example.com',
  logoUrl: 'https://acme.example.com/logo.svg',
  logoLicenseUrl: null,
  aliases: [],
  category: 'prov',
  portalName: 'Acme MyChart',
  portalUrl: 'https://portal.acme.example.com',
  portalDescription: null,
  portalLogoUrl: null,
  portalLogoLicenseUrl: null,
  addressLine: '1 Main Street\nSuite 200',
  addressCity: 'Springfield',
  addressState: 'IL',
  addressPostalCode: '62701',
  addressCountry: 'US',
  identifier: 'https://acme.example.com',
  identifierSystem: 'urn:ietf:rfc:3986',
  developerUrl: 'https://developer.acme.example.com',
  additionalPortals: [],
  loginTheme: null,
  appStoreUrl: null,
}

const SERVERS: BrandServer[] = [
  { identifier: 'r4', name: 'Main', fhirVersion: 'R4' },
  { identifier: 'lab', name: 'Lab', fhirVersion: 'R4', organizationIds: ['org-a'] },
]

interface Harness {
  service: InstanceType<typeof BrandBundleService>
  setBrand(brand: BrandConfigType): void
  setServers(servers: BrandServer[]): void
  setOrgBrands(orgs: Map<string, Partial<BrandConfigType>>): void
  advance(ms: number): void
}

function harness(): Harness {
  let brand = BASE
  let servers = SERVERS
  let orgBrands = new Map<string, Partial<BrandConfigType>>()
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const service = new BrandBundleService({
    sources: {
      brand: () => brand,
      servers: async () => servers,
      orgBrands: () => orgBrands,
    },
    changes: new AdminConfigStore(new MemoryBackend()),
    now: () => clock,
    cacheTtlMs: 0,
  })
  return {
    service,
    setBrand: (next) => { brand = next },
    setServers: (next) => { servers = next },
    setOrgBrands: (next) => { orgBrands = next },
    advance: (ms) => { clock += ms },
  }
}

function resourceById(bundle: BrandBundle, id: string): BrandResource {
  const entry = bundle.entry.find((candidate) => candidate.resource.id === id)
  if (!entry) throw new Error(`no resource ${id}`)
  return entry.resource
}

function extensions(resource: object, url: string): Extension[] {
  const all: unknown = Reflect.get(resource, 'extension')
  if (!Array.isArray(all)) return []
  return all.filter((ext: Extension) => ext.url === url)
}

describe('brand bundle change tracking', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  it('keeps timestamp and ETag across rebuilds when nothing changed', async () => {
    const first = await h.service.getBrandBundle()
    h.advance(3_600_000)
    h.service.clearCache()
    const second = await h.service.getBrandBundle()

    expect(second.bundle.timestamp).toBe(first.bundle.timestamp)
    expect(second.etag).toBe(first.etag)
    expect(first.etag).toMatch(/^W\//)
  })

  it('moves the timestamp to the moment the content changed and stamps only the changed resource', async () => {
    const first = await h.service.getBrandBundle()
    h.advance(60_000)
    h.setBrand({ ...BASE, aliases: ['Acme'] })
    h.service.clearCache()
    const second = await h.service.getBrandBundle()

    expect(second.etag).not.toBe(first.etag)
    expect(second.bundle.timestamp).toBe('2026-01-01T00:01:00.000Z')
    expect(resourceById(second.bundle, 'primary-brand').meta?.lastUpdated).toBe('2026-01-01T00:01:00.000Z')
    expect(resourceById(second.bundle, 'endpoint-lab').meta?.lastUpdated).toBe('2026-01-01T00:00:00.000Z')
  })

  it('treats a removed FHIR server as a change to the bundle', async () => {
    const first = await h.service.getBrandBundle()
    h.advance(5_000)
    h.setServers([SERVERS[0]])
    h.service.clearCache()
    const second = await h.service.getBrandBundle()

    expect(second.bundle.timestamp).not.toBe(first.bundle.timestamp)
    expect(second.bundle.entry.some((entry) => entry.resource.id === 'endpoint-lab')).toBe(false)
  })

  it('sets meta.lastUpdated on every entry and never later than the bundle timestamp', async () => {
    const { bundle } = await h.service.getBrandBundle()
    for (const entry of bundle.entry) {
      expect(entry.resource.meta?.lastUpdated).toBeDefined()
      expect(Date.parse(entry.resource.meta?.lastUpdated ?? '')).toBeLessThanOrEqual(Date.parse(bundle.timestamp))
    }
  })
})

describe('conditional GET', () => {
  it('answers a matching If-None-Match with 304 carrying ETag and Cache-Control', async () => {
    const { service } = harness()
    const { etag } = await service.getBrandBundle()

    for (const header of [etag, `"other", ${etag}`, '*', etag.replace(/^W\//, '')]) {
      const result = await service.respond(header)
      expect(result.status).toBe(304)
      expect(result.headers.etag).toBe(etag)
      expect(result.headers['cache-control']).toContain('max-age')
    }
  })

  it('answers a stale tag with the bundle and its validators', async () => {
    const { service } = harness()
    const result = await service.respond('W/"stale"')
    expect(result.status).toBe(200)
    expect(result.headers.etag).toMatch(/^W\//)
    expect(result.headers['last-modified']).toBeDefined()
    expect(result.status === 200 && result.bundle.resourceType).toBe('Bundle')
  })
})

describe('brand identifiers', () => {
  it('advertises the identifier of exactly one Organization, with the configured system', async () => {
    const h = harness()
    h.setBrand({ ...BASE, identifier: 'urn:oid:1.2.3', identifierSystem: 'urn:ietf:rfc:3986' })
    h.setOrgBrands(new Map([['org-a', { name: 'Acme North' }], ['org-b', { name: 'Acme South', website: 'https://south.example.com' }]]))
    const advertised = h.service.advertisedIdentifier()
    const { bundle } = await h.service.getBrandBundle()

    expect(advertised).toEqual({ system: 'urn:ietf:rfc:3986', value: 'urn:oid:1.2.3' })
    const holders = bundle.entry.filter((entry) => entry.resource.resourceType === 'Organization'
      && (entry.resource.identifier ?? []).some((id) => id.system === advertised.system && id.value === advertised.value))
    expect(holders.map((entry) => entry.resource.id)).toEqual(['primary-brand'])
  })

  it('gives an organization brand its own website as identifier, or none', async () => {
    const h = harness()
    h.setOrgBrands(new Map([['org-a', { name: 'Acme North' }], ['org-b', { name: 'Acme South', website: 'https://south.example.com' }]]))
    const { bundle } = await h.service.getBrandBundle()

    expect(resourceById(bundle, 'org-org-a').identifier).toBeUndefined()
    expect(resourceById(bundle, 'org-org-b').identifier).toEqual([{ system: 'urn:ietf:rfc:3986', value: 'https://south.example.com' }])
  })

  it('drops an organization identifier that collides with the primary one', async () => {
    const h = harness()
    h.setOrgBrands(new Map([['org-a', { name: 'Clone', identifier: BASE.identifier }]]))
    const { bundle } = await h.service.getBrandBundle()

    expect(resourceById(bundle, 'org-org-a').identifier).toBeUndefined()
  })
})

describe('brand resources', () => {
  it('publishes the street address lines alongside city and country', async () => {
    const { bundle } = await harness().service.getBrandBundle()
    expect(resourceById(bundle, 'primary-brand').address).toEqual([{
      line: ['1 Main Street', 'Suite 200'], city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US',
    }])
  })

  it('publishes an address with only a country', async () => {
    const h = harness()
    h.setBrand({ ...BASE, addressLine: null, addressCity: null, addressState: null, addressPostalCode: null, addressCountry: 'DE' })
    const { bundle } = await h.service.getBrandBundle()
    expect(resourceById(bundle, 'primary-brand').address).toEqual([{ country: 'DE' }])
  })

  it('emits one organization-portal extension per portal, each pointing at endpoints of the brand', async () => {
    const h = harness()
    h.setBrand({ ...BASE, additionalPortals: [{ name: 'Lab Results', url: 'https://lab.acme.example.com', serverIds: ['lab'] }] })
    const { bundle } = await h.service.getBrandBundle()
    const brand = resourceById(bundle, 'primary-brand')
    const portals = extensions(brand, 'http://hl7.org/fhir/StructureDefinition/organization-portal')

    expect(portals).toHaveLength(2)
    const second = portals[1].extension ?? []
    expect(second.find((part) => part.url === 'portalName')?.valueString).toBe('Lab Results')
    expect(second.filter((part) => part.url === 'portalEndpoint').map((part) => part.valueReference?.reference)).toEqual(['Endpoint/endpoint-lab'])
  })

  it('does not point the brandBundle sub-extension at the bundle itself', async () => {
    const { bundle } = await harness().service.getBrandBundle()
    const brandExt = extensions(resourceById(bundle, 'primary-brand'), 'http://hl7.org/fhir/StructureDefinition/organization-brand')
    expect((brandExt[0]?.extension ?? []).some((part) => part.url === 'brandBundle')).toBe(false)
  })

  it('lists the developer configuration URL as the endpoint contact', async () => {
    const { bundle } = await harness().service.getBrandBundle()
    expect(resourceById(bundle, 'endpoint-r4').contact).toEqual([{ system: 'url', value: 'https://developer.acme.example.com' }])
  })
})
