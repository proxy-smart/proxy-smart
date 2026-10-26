// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { parseJson } from '../type-guards'

/** Records hidden from a whole-patient share; enforced by the SHL FHIR proxy (see ./scope). */
const ShareScope = Type.Object({
  /** FHIR resource types fully hidden (a whole category was deselected). */
  excludedTypes: Type.Array(Type.String()),
  /** Individually hidden resources as `ResourceType/id`. */
  excludedIds: Type.Array(Type.String()),
  /** Observation `category` codes fully hidden (e.g. `vital-signs`, `laboratory`). */
  excludedObservationCategories: Type.Array(Type.String()),
})
export type ShareScope = Static<typeof ShareScope>

/** Shares stored before excludedObservationCategories existed lack it. */
const StoredShareScope = Type.Composite([
  Type.Omit(ShareScope, ['excludedObservationCategories']),
  Type.Partial(Type.Pick(ShareScope, ['excludedObservationCategories'])),
])

/** What a share lets its recipient write. Each kind is granted separately. */
const ShlWriteScope = Type.Object({
  /** May STOW DICOM instances for the shared patient. */
  dicom: Type.Optional(Type.Boolean()),
})
export type ShlWriteScope = Static<typeof ShlWriteScope>

/** The recipient's signature over what they are about to write; a later Provenance is built from it. */
const ShlAttestation = Type.Object({
  /** The name the signature is claimed under: the patient's label, or self-entered. */
  name: Type.String(),
  nameSource: Type.Union([Type.Literal('patient'), Type.Literal('recipient')]),
  /** The drawn mark, as a data URL. */
  signature: Type.String(),
  signedAt: Type.Number(),
})
export type ShlAttestation = Static<typeof ShlAttestation>

const ShlPayload = Type.Object({
  url: Type.String(),
  key: Type.String(),
  exp: Type.Optional(Type.Number()),
  flag: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
})

export interface ShlSession {
  /** SHL payload from kill-the-clipboard (for manifest serving) */
  shl: Static<typeof ShlPayload>
  /** JWE compact string (spec-compliant, encrypted with SHL key) */
  jwe: string
  /** Opaque 256-bit session token the viewer sends as its Bearer token */
  sessionToken: string
  patientId: string
  /** Scopes the SHL to a single imaging study */
  studyInstanceUID?: string
  fhirServerUrl: string
  /** Epoch ms */
  expiresAt: number
  verifiedOnly: boolean
  shareScope?: ShareScope
  /** What the recipient may WRITE; absent means read-only. */
  writeScope?: ShlWriteScope
  /** Who the patient says this link is for. A label, not an identity: an SHL is a bearer link. */
  recipientName?: string
  attestation?: ShlAttestation
  /** Number of manifest accesses */
  accessCount: number
  /** SHA-256 of the passcode */
  passcodeHash?: string
}

const NullableText = Type.Union([Type.String(), Type.Null()])

/** A session as every backend stores it: flat, JSON columns serialized. */
export const ShlRow = Type.Object({
  id: Type.String(),
  session_token: Type.String(),
  shl_payload: Type.String(),
  jwe: Type.String(),
  patient_id: Type.String(),
  study_instance_uid: NullableText,
  fhir_server_url: Type.String(),
  expires_at: Type.Number(),
  verified_only: Type.Number(),
  share_scope: NullableText,
  write_scope: NullableText,
  recipient_name: NullableText,
  attestation: NullableText,
  access_count: Type.Number(),
  passcode_hash: NullableText,
  consent_mirrored: Type.Number(),
  created_at: Type.Number(),
})
export type ShlRow = Static<typeof ShlRow>

/** One distinct (fingerprinted) device that opened a share; `count` is its opens. */
export const ShlAccessRow = Type.Object({
  shl_id: Type.String(),
  fingerprint: Type.String(),
  first_seen: Type.Number(),
  last_seen: Type.Number(),
  count: Type.Number(),
})
export type ShlAccessRow = Static<typeof ShlAccessRow>

/** Column order shared by every backend's INSERT. */
export const SHL_ROW_COLUMNS = Object.keys(ShlRow.properties).filter((key): key is keyof ShlRow => key in ShlRow.properties)

export type ShlLookupColumn = 'id' | 'session_token'

/** Storage for SHL sessions. Reads return raw rows; the store validates them. */
export interface ShlSessionBackend {
  put(row: ShlRow): Promise<void>
  find(column: ShlLookupColumn, value: string): Promise<unknown>
  remove(id: string): Promise<void>
  incrementAccessCount(id: string): Promise<void>
  recordAccess(id: string, fingerprint: string, now: number): Promise<void>
  distinctDevices(id: string): Promise<number>
  /** Sets the attestation only if none is stored; true when it was written. */
  recordAttestation(id: string, attestation: string): Promise<boolean>
  markConsentMirrored(id: string): Promise<void>
  listUnmirrored(now: number, limit: number): Promise<unknown[]>
  dispose(): void
}

const CORRUPT = Symbol('corrupt')

function jsonColumn<T extends TSchema>(schema: T, text: string | null): Static<T> | undefined | typeof CORRUPT {
  if (text === null || text === '') return undefined
  const parsed = parseJson(text)
  return Value.Check(schema, parsed) ? parsed : CORRUPT
}

const json = (value: object | undefined) => (value ? JSON.stringify(value) : null)

export function toShlRow(id: string, session: ShlSession, createdAt: number): ShlRow {
  return {
    id,
    session_token: session.sessionToken,
    shl_payload: JSON.stringify(session.shl),
    jwe: session.jwe,
    patient_id: session.patientId,
    study_instance_uid: session.studyInstanceUID ?? null,
    fhir_server_url: session.fhirServerUrl,
    expires_at: session.expiresAt,
    verified_only: session.verifiedOnly ? 1 : 0,
    share_scope: json(session.shareScope),
    write_scope: json(session.writeScope),
    recipient_name: session.recipientName ?? null,
    attestation: json(session.attestation),
    access_count: session.accessCount,
    passcode_hash: session.passcodeHash ?? null,
    consent_mirrored: 0,
    created_at: createdAt,
  }
}

/** Undefined when a JSON column does not match its schema: a share whose scope cannot be read must not open. */
export function fromShlRow(row: ShlRow): ShlSession | undefined {
  const shl = parseJson(row.shl_payload)
  const shareScope = jsonColumn(StoredShareScope, row.share_scope)
  const writeScope = jsonColumn(ShlWriteScope, row.write_scope)
  const attestation = jsonColumn(ShlAttestation, row.attestation)
  if (!Value.Check(ShlPayload, shl) || shareScope === CORRUPT || writeScope === CORRUPT || attestation === CORRUPT) {
    return undefined
  }
  return {
    shl,
    jwe: row.jwe,
    sessionToken: row.session_token,
    patientId: row.patient_id,
    studyInstanceUID: row.study_instance_uid ?? undefined,
    fhirServerUrl: row.fhir_server_url,
    expiresAt: row.expires_at,
    verifiedOnly: row.verified_only === 1,
    shareScope: shareScope && {
      ...shareScope,
      excludedObservationCategories: shareScope.excludedObservationCategories ?? [],
    },
    writeScope,
    recipientName: row.recipient_name ?? undefined,
    attestation,
    accessCount: row.access_count,
    passcodeHash: row.passcode_hash ?? undefined,
  }
}
