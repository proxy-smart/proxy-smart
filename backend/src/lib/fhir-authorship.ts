// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createPrivateKey, createPublicKey } from 'crypto'
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose'
import { config } from '../config'
import { logger } from './logger'
import { normalizeFhirUser } from './patient-context'
import { getProxyKeyPair, PROXY_SIGNING_ALG } from './proxy-signing'
import { isRecord } from './type-guards'

/** Marks the Provenance the proxy records, signed, for every record a signed-in user adds. */
export const ADDED_BY_POLICY = 'https://proxy-smart.com/fhir/policy/added-by'

const UNTRACKED_TYPES: ReadonlySet<string> = new Set(['Provenance', 'AuditEvent'])
const CHART_FIELDS = ['subject', 'patient', 'beneficiary'] as const
const ENTERER = { system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'enterer', display: 'Enterer' }
const CREATE = { system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code: 'CREATE', display: 'create' }
const SOURCE_SIGNATURE = { system: 'urn:iso-astm:E1762-95:2013', code: '1.2.840.10065.1.12.1.14', display: 'Source Signature' }
const CREATED_RE = /([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})\/_history\/([A-Za-z0-9\-.]{1,64})$/

type FhirResource = Record<string, unknown>

/** One record an upstream create answered with, at the version it was created as. */
export interface CreatedRecord {
  type: string
  id: string
  version: string
  /** The Patient whose chart it belongs to, so a patient-scoped search finds its Provenance. */
  chart?: string
}

export interface AuthorshipRequest {
  created: CreatedRecord[]
  tokenPayload: Record<string, unknown>
  serverUrl: string
  authHeader: string
  upstreamFetch: (url: string, init?: RequestInit) => Promise<Response>
}

/** `Type/id/_history/version`: the creation an authorship signature is bound to. */
export function creationReference(record: Pick<CreatedRecord, 'type' | 'id' | 'version'>): string {
  return `${record.type}/${record.id}/_history/${record.version}`
}

/** The `Patient/id` a record is about: its subject, patient or beneficiary. */
export function chartPatientOf(resource: FhirResource): string | undefined {
  for (const field of CHART_FIELDS) {
    const ref = resource[field]
    const match = isRecord(ref) && typeof ref.reference === 'string' ? /(?:^|\/)Patient\/([^/]+)$/.exec(ref.reference) : null
    if (match) return `Patient/${match[1]}`
  }
  return undefined
}

/** The signed-in user a record is attributed to: their fhirUser, never the app or the patient in context. */
export function actorOf(tokenPayload: Record<string, unknown>): string | undefined {
  const fhirUser = tokenPayload.fhirUser
  if (typeof fhirUser !== 'string') return undefined
  const actor = normalizeFhirUser(fhirUser)
  return /^[A-Z][A-Za-z]+\/[^/]+$/.test(actor) ? actor : undefined
}

function fromResource(resource: unknown): CreatedRecord | undefined {
  if (!isRecord(resource) || typeof resource.resourceType !== 'string' || typeof resource.id !== 'string') return undefined
  const version = isRecord(resource.meta) ? resource.meta.versionId : undefined
  if (typeof version !== 'string') return undefined
  return { type: resource.resourceType, id: resource.id, version, chart: chartPatientOf(resource) }
}

function fromLocation(location: unknown): CreatedRecord | undefined {
  if (typeof location !== 'string') return undefined
  const match = CREATED_RE.exec(location.split('?')[0])
  return match ? { type: match[1], id: match[2], version: match[3] } : undefined
}

/** What an upstream answer created: one record for a 201, or every `201` entry of a transaction or batch. */
export function createdRecords(status: number, body: unknown, location: string | undefined): CreatedRecord[] {
  const created: CreatedRecord[] = []
  if (isRecord(body) && body.resourceType === 'Bundle' && (body.type === 'transaction-response' || body.type === 'batch-response')) {
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      if (!isRecord(entry) || !isRecord(entry.response) || !String(entry.response.status).startsWith('201')) continue
      const record = fromResource(entry.resource) ?? fromLocation(entry.response.location)
      if (record) created.push(record)
    }
  } else if (status === 201) {
    const record = fromResource(body) ?? fromLocation(location)
    if (record) created.push(record)
  }
  return created.filter((record) => !UNTRACKED_TYPES.has(record.type))
}

let keys: { kid: string; signing: CryptoKey; verifying: CryptoKey } | null = null

async function signingKeys(): Promise<{ kid: string; signing: CryptoKey; verifying: CryptoKey }> {
  const pair = getProxyKeyPair()
  if (keys?.kid === pair.kid) return keys
  const pkcs8 = createPrivateKey(pair.privateKeyPem).export({ type: 'pkcs8', format: 'pem' }).toString()
  const spki = createPublicKey(pair.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString()
  keys = {
    kid: pair.kid,
    signing: await importPKCS8(pkcs8, PROXY_SIGNING_ALG),
    verifying: await importSPKI(spki, PROXY_SIGNING_ALG),
  }
  return keys
}

/** The Provenance the proxy keeps for one added record: who added it, signed so no client can claim it. */
export async function addedByProvenance(record: CreatedRecord, actor: string, now = new Date()): Promise<FhirResource> {
  const target = creationReference(record)
  const { kid, signing } = await signingKeys()
  const jws = await new SignJWT({ tgt: target })
    .setProtectedHeader({ alg: PROXY_SIGNING_ALG, kid })
    .setIssuer(config.baseUrl)
    .setSubject(actor)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .sign(signing)
  const recorded = now.toISOString()
  const anchor = record.chart && record.chart !== `${record.type}/${record.id}` ? [{ reference: record.chart }] : []
  return {
    resourceType: 'Provenance',
    target: [{ reference: target }, ...anchor],
    recorded,
    policy: [ADDED_BY_POLICY],
    activity: { coding: [CREATE] },
    agent: [{ type: { coding: [ENTERER] }, who: { reference: actor } }],
    signature: [{
      type: [SOURCE_SIGNATURE],
      when: recorded,
      who: { identifier: { system: 'urn:ietf:rfc:3986', value: config.baseUrl }, display: 'Proxy Smart' },
      sigFormat: 'application/jose',
      data: Buffer.from(jws).toString('base64'),
    }],
  }
}

/** Who the proxy signed as having added `creation`, or undefined when this Provenance proves nothing. */
export async function signedAdder(provenance: FhirResource, creation: string): Promise<string | undefined> {
  if (!Array.isArray(provenance.policy) || !provenance.policy.includes(ADDED_BY_POLICY)) return undefined
  const { verifying } = await signingKeys()
  for (const signature of Array.isArray(provenance.signature) ? provenance.signature : []) {
    if (!isRecord(signature) || signature.sigFormat !== 'application/jose' || typeof signature.data !== 'string') continue
    try {
      const jws = Buffer.from(signature.data, 'base64').toString('utf8')
      const { payload } = await jwtVerify(jws, verifying, { issuer: config.baseUrl, algorithms: [PROXY_SIGNING_ALG] })
      if (payload.tgt === creation && typeof payload.sub === 'string') return payload.sub
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Record who added each created record. A failure is logged, not raised: the record stands,
 * only its adder cannot erase it later.
 */
export async function recordAuthorship(req: AuthorshipRequest): Promise<void> {
  const actor = actorOf(req.tokenPayload)
  if (!actor || req.created.length === 0) return
  try {
    const provenance = await Promise.all(req.created.map((record) => addedByProvenance(record, actor)))
    const body = provenance.length === 1
      ? provenance[0]
      : { resourceType: 'Bundle', type: 'transaction', entry: provenance.map((resource) => ({ resource, request: { method: 'POST', url: 'Provenance' } })) }
    const headers: Record<string, string> = { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', Prefer: 'return=minimal' }
    if (req.authHeader) headers.Authorization = req.authHeader
    const url = provenance.length === 1 ? `${req.serverUrl}/Provenance` : req.serverUrl
    const res = await req.upstreamFetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  } catch (error) {
    logger.fhir.error('Could not record who added a record', { actor, records: req.created.map(creationReference) }, error)
  }
}
