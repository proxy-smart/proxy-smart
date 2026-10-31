// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * User-access Brand Bundle at /branding.json. Timestamps move only when a resource's content hash
 * does (recorded in the shared admin-config store), so they and the ETag survive rebuilds and nodes.
 */

import { sha256 } from './hash'
import { getAllServers, ensureServersInitialized } from './fhir-server-store'
import { getRuntimeBrandConfig } from './runtime-config'
import { getAllOrgBrands } from './org-branding'
import { logger } from './logger'
import { adminConfigStore, type AdminConfigStore, type AdminConfigValue } from './admin-config-store'
import { weakEtag, ifNoneMatchSatisfied } from './http-caching'
import { isRecord } from './type-guards'
import {
  brandIdentifier,
  buildBrandEntries,
  ENDPOINT_FHIR_VERSION_URL,
  ORGANIZATION_BRAND_URL,
  ORGANIZATION_PORTAL_URL,
  type BrandBundleEntry,
  type BrandIdentifier,
  type BrandServer,
} from './brand-resources'
import type { BrandConfigType } from '@/schemas'
import {
  type UserAccessBrandsBundle,
  validateEndpointFhirVersion,
  validateOrganizationBrand,
  validateOrganizationPortal,
  validateUserAccessBrand,
  validateUserAccessBrandsBundle,
  validateUserAccessEndpoint,
} from '@max-health-inc/fhir-smart'

export interface BrandBundle extends UserAccessBrandsBundle {
  id: string
  timestamp: string
  entry: BrandBundleEntry[]
}

export interface BrandBundleSources {
  brand(): BrandConfigType
  servers(): Promise<BrandServer[]>
  orgBrands(): ReadonlyMap<string, Partial<BrandConfigType>>
}

export const BRAND_BUNDLE_CACHE_CONTROL = 'public, max-age=60'

export type BrandBundleResponse =
  | { status: 304; headers: Record<string, string> }
  | { status: 200; headers: Record<string, string>; bundle: BrandBundle }

const CHANGES_KEY = 'brand-bundle-changes'

interface ChangeMark { hash: string; lastModified: string }
interface ChangeLog { bundle: ChangeMark | null; resources: Record<string, ChangeMark> }

const EMPTY_LOG: ChangeLog = { bundle: null, resources: {} }

function isChangeMark(value: unknown): value is ChangeMark {
  return isRecord(value) && typeof value.hash === 'string' && typeof value.lastModified === 'string'
}

function readChangeLog(_defaults: ChangeLog, raw: AdminConfigValue | null): ChangeLog {
  const bundle = raw?.bundle
  const resources = raw?.resources
  const marks: Record<string, ChangeMark> = {}
  if (isRecord(resources)) {
    for (const [key, mark] of Object.entries(resources)) if (isChangeMark(mark)) marks[key] = mark
  }
  return { bundle: isChangeMark(bundle) ? bundle : null, resources: marks }
}

const resourceKey = (entry: BrandBundleEntry): string => `${entry.resource.resourceType}/${entry.resource.id ?? ''}`

interface ContentHashes { bundle: string; resources: Map<string, string> }

function hashContent(entries: BrandBundleEntry[]): ContentHashes {
  return {
    bundle: sha256(JSON.stringify(entries), 'base64url'),
    resources: new Map(entries.map((entry) => [resourceKey(entry), sha256(JSON.stringify(entry.resource), 'base64url')])),
  }
}

function isCurrent(log: ChangeLog, hashes: ContentHashes): boolean {
  if (log.bundle?.hash !== hashes.bundle) return false
  for (const [key, hash] of hashes.resources) if (log.resources[key]?.hash !== hash) return false
  return true
}

/** Keeps the timestamp of every unchanged hash; stamps `now` on anything new or different. */
function stamp(log: ChangeLog, hashes: ContentHashes, now: string): ChangeLog {
  const resources: Record<string, ChangeMark> = {}
  for (const [key, hash] of hashes.resources) {
    const previous = log.resources[key]
    resources[key] = previous?.hash === hash ? previous : { hash, lastModified: now }
  }
  const bundle = log.bundle?.hash === hashes.bundle ? log.bundle : { hash: hashes.bundle, lastModified: now }
  return { bundle, resources }
}

const defaultSources: BrandBundleSources = {
  brand: getRuntimeBrandConfig,
  orgBrands: getAllOrgBrands,
  async servers() {
    await ensureServersInitialized()
    return (await getAllServers()).map((server) => ({
      identifier: server.identifier,
      name: server.name,
      fhirVersion: server.metadata.fhirVersion,
      organizationIds: server.organizationIds,
    }))
  },
}

export interface BrandBundleServiceOptions {
  sources?: BrandBundleSources
  changes?: AdminConfigStore
  now?: () => number
  cacheTtlMs?: number
}

export class BrandBundleService {
  private cache: { bundle: BrandBundle; etag: string; builtAt: number } | null = null
  private readonly sources: BrandBundleSources
  private readonly changes: AdminConfigStore
  private readonly now: () => number
  private readonly cacheTtlMs: number

  constructor(options: BrandBundleServiceOptions = {}) {
    this.sources = options.sources ?? defaultSources
    this.changes = options.changes ?? adminConfigStore
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000
  }

  async getBrandBundle(): Promise<{ bundle: BrandBundle; etag: string }> {
    const now = this.now()
    if (this.cache && now - this.cache.builtAt < this.cacheTtlMs) {
      return { bundle: this.cache.bundle, etag: this.cache.etag }
    }

    const entries = buildBrandEntries({
      brand: this.sources.brand(),
      servers: await this.sources.servers(),
      orgBrands: this.sources.orgBrands(),
    })
    const hashes = hashContent(entries)
    const log = await this.recordChanges(hashes, new Date(now).toISOString())

    const bundle: BrandBundle = {
      resourceType: 'Bundle',
      id: 'user-access-brands',
      type: 'collection',
      timestamp: log.bundle?.lastModified ?? new Date(now).toISOString(),
      entry: entries.map((entry) => {
        const lastUpdated = log.resources[resourceKey(entry)]?.lastModified
        return lastUpdated ? { ...entry, resource: { ...entry.resource, meta: { lastUpdated } } } : entry
      }),
    }
    await validateBundle(bundle)

    const etag = weakEtag(hashes.bundle)
    this.cache = { bundle, etag, builtAt: now }
    return { bundle, etag }
  }

  /** The body or a 304 for a GET carrying `If-None-Match`; both carry the validators and caching policy. */
  async respond(ifNoneMatch: string | null | undefined): Promise<BrandBundleResponse> {
    const { bundle, etag } = await this.getBrandBundle()
    const headers = {
      etag,
      'cache-control': BRAND_BUNDLE_CACHE_CONTROL,
      'last-modified': new Date(bundle.timestamp).toUTCString(),
    }
    if (ifNoneMatchSatisfied(ifNoneMatch, etag)) return { status: 304, headers }
    return { status: 200, headers, bundle }
  }

  /** The identifier `.well-known/smart-configuration` advertises, from the same brand the bundle uses. */
  advertisedIdentifier(): BrandIdentifier {
    return brandIdentifier(this.sources.brand())
  }

  clearCache(): void {
    this.cache = null
  }

  private async recordChanges(hashes: ContentHashes, now: string): Promise<ChangeLog> {
    const known = this.changes.get(CHANGES_KEY, EMPTY_LOG, readChangeLog)
    if (isCurrent(known, hashes)) return known
    try {
      return await this.changes.mutate(CHANGES_KEY, EMPTY_LOG, readChangeLog, (current) => stamp(current, hashes, now))
    } catch (error) {
      logger.warn('brand-bundle', 'Could not persist brand bundle change times; using this build', { error })
      return stamp(known, hashes, now)
    }
  }
}

async function validateBundle(bundle: BrandBundle): Promise<void> {
  const report = (subject: string, result: { errors: string[]; warnings: string[] }) => {
    for (const warning of result.warnings) logger.debug('brand-bundle', `${subject} validation warning: ${warning}`)
    if (result.errors.length > 0) logger.warn('brand-bundle', `${subject} validation errors: ${result.errors.join('; ')}`)
  }

  report('Bundle', await validateUserAccessBrandsBundle(bundle))
  for (const { resource } of bundle.entry) {
    if (resource.resourceType === 'Endpoint') {
      report(`Endpoint ${resource.id}`, await validateUserAccessEndpoint(resource))
      for (const ext of resource.extension ?? []) {
        if (ext.url === ENDPOINT_FHIR_VERSION_URL && ext.valueCode) {
          report('EndpointFhirVersion', await validateEndpointFhirVersion({ ...ext, url: ENDPOINT_FHIR_VERSION_URL }))
        }
      }
      continue
    }
    report(`Organization ${resource.id}`, await validateUserAccessBrand(resource))
    for (const ext of resource.extension ?? []) {
      if (ext.url === ORGANIZATION_BRAND_URL) {
        report('OrganizationBrand', await validateOrganizationBrand({ ...ext, url: ORGANIZATION_BRAND_URL }))
      } else if (ext.url === ORGANIZATION_PORTAL_URL) {
        report('OrganizationPortal', await validateOrganizationPortal({ ...ext, url: ORGANIZATION_PORTAL_URL, extension: ext.extension ?? [] }))
      }
    }
  }
}

export const brandBundleService = new BrandBundleService()
