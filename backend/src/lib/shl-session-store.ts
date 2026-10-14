// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Persistent SHL Session Store — SQLite-backed via bun:sqlite
 *
 * Survives server restarts. Uses WAL mode for concurrent read/write performance.
 * Expired entries are cleaned up lazily on read and periodically via interval.
 *
 * Drop-in replacement for the previous in-memory Map<string, ShlSession>.
 */
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { logger } from './logger'
import { DATA_DIR } from './paths'
import { parseJson } from './type-guards'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Selective-sharing scope for a whole-patient share. Absent (or with all lists
 * empty) means "share everything". Enforced server-side in the SHL FHIR proxy
 * (see shl-scope.ts), so deselected records are unreachable by the recipient.
 */
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

/**
 * The recipient's signature over what they are about to write. Scratch space
 * until a write turns it into a `Provenance.signature`; never the evidence of record.
 */
const ShlAttestation = Type.Object({
  /** The name the signature is claimed under — the patient's label, or self-entered. */
  name: Type.String(),
  /** Whether `name` came from the patient at mint or from the recipient at signing. */
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
  /** Opaque session token (256-bit, base64url) — used as Bearer token by viewer */
  sessionToken: string
  /** Patient ID to scope FHIR requests */
  patientId: string
  /** Optional DICOM Study Instance UID — when set, scopes the SHL to a single imaging study */
  studyInstanceUID?: string
  /** Upstream FHIR server base URL */
  fhirServerUrl: string
  /** Expiry timestamp (ms) */
  expiresAt: number
  /** Whether verified-only filter is active */
  verifiedOnly: boolean
  /** Optional selective-sharing scope (record/category de-selection). */
  shareScope?: ShareScope
  /**
   * What the recipient may WRITE. Absent means read-only, which is every share
   * minted before this existed and every share whose patient did not opt in.
   *
   * An object rather than a flag because write access is scoped per kind: letting
   * a radiology department add imaging is not the same grant as letting them
   * write observations, and the patient chooses which.
   */
  writeScope?: ShlWriteScope
  /**
   * Who the patient says this link is for, as a display name. A LABEL, not an
   * identity: an SHL is a bearer link, so whoever holds it can claim to be this
   * person. Optional — when the patient does not name anyone, the recipient
   * supplies their own name when they attest.
   */
  recipientName?: string
  /** The recipient's signature, captured before any write is accepted. */
  attestation?: ShlAttestation
  /** Number of manifest accesses */
  accessCount: number
  /** Optional passcode (hashed) */
  passcodeHash?: string
}

const NullableText = Type.Union([Type.String(), Type.Null()])

/** Row shape in SQLite (flat, JSON-serialized where needed) */
const ShlRow = Type.Object({
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
})
type ShlRow = Static<typeof ShlRow>

const IdRow = Type.Object({ id: Type.String() })
const CountRow = Type.Object({ cnt: Type.Number() })

/** Sentinel for a JSON column that is present but does not match its schema. */
const CORRUPT = Symbol('corrupt')

function jsonColumn<T extends TSchema>(schema: T, text: string | null): Static<T> | undefined | typeof CORRUPT {
  if (text === null || text === '') return undefined
  const parsed = parseJson(text)
  return Value.Check(schema, parsed) ? parsed : CORRUPT
}

// ── Database setup ───────────────────────────────────────────────────────────

const DB_PATH = process.env.SHL_DB_PATH || join(DATA_DIR, 'shl-sessions.sqlite')

function createDatabase(): Database {
  mkdirSync(DATA_DIR, { recursive: true })

  const db = new Database(DB_PATH)

  // WAL mode for better concurrent performance
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS shl_sessions (
      id TEXT PRIMARY KEY,
      session_token TEXT NOT NULL UNIQUE,
      shl_payload TEXT NOT NULL,
      jwe TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      study_instance_uid TEXT,
      fhir_server_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      verified_only INTEGER NOT NULL DEFAULT 0,
      share_scope TEXT,
      write_scope TEXT,
      recipient_name TEXT,
      attestation TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      passcode_hash TEXT,
      consent_mirrored INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `)

  // Idempotent migration: add study-scope column to pre-existing DBs.
  try {
    db.run('ALTER TABLE shl_sessions ADD COLUMN study_instance_uid TEXT')
  } catch {
    /* column already exists */
  }

  // Idempotent migration: add selective-sharing scope column to pre-existing DBs.
  try {
    db.run('ALTER TABLE shl_sessions ADD COLUMN share_scope TEXT')
  } catch {
    /* column already exists */
  }

  // Idempotent migration: track whether the SHL→Consent mirror was written, so a
  // reconciliation sweep can repair sessions whose best-effort mirror failed
  // (revocation depends on the Consent existing).
  try {
    db.run('ALTER TABLE shl_sessions ADD COLUMN consent_mirrored INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* column already exists */
  }

  // Idempotent migrations: write access. A pre-existing row has no write_scope,
  // which reads as read-only — the behaviour every share had before this existed.
  for (const column of ['write_scope TEXT', 'recipient_name TEXT', 'attestation TEXT']) {
    try {
      db.run(`ALTER TABLE shl_sessions ADD COLUMN ${column}`)
    } catch {
      /* column already exists */
    }
  }

  // Index for token lookups (FHIR proxy uses this path)
  db.run('CREATE INDEX IF NOT EXISTS idx_shl_session_token ON shl_sessions(session_token)')
  // Index for expiry cleanup
  db.run('CREATE INDEX IF NOT EXISTS idx_shl_expires_at ON shl_sessions(expires_at)')

  // Per-recipient access tracking: one row per distinct (fingerprinted) device
  // that has opened the share. Row count = distinct devices; `count` = opens by
  // that device. Total opens live on the session's access_count. Actual access
  // events are also emitted as FHIR AuditEvents (see consent/shl-audit).
  db.run(`
    CREATE TABLE IF NOT EXISTS shl_accesses (
      shl_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (shl_id, fingerprint)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_shl_accesses_shl_id ON shl_accesses(shl_id)')

  return db
}

// ── Store class ──────────────────────────────────────────────────────────────

class ShlSessionStore {
  private db: Database
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    this.db = createDatabase()

    // Cleanup expired entries every 60s
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 60_000)
    this.cleanupTimer.unref()

    // Initial cleanup on startup
    this.purgeExpired()
  }

  /** Store a new SHL session */
  set(id: string, session: ShlSession): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO shl_sessions
        (id, session_token, shl_payload, jwe, patient_id, study_instance_uid, fhir_server_url, expires_at, verified_only, share_scope, write_scope, recipient_name, attestation, access_count, passcode_hash, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      session.sessionToken,
      JSON.stringify(session.shl),
      session.jwe,
      session.patientId,
      session.studyInstanceUID ?? null,
      session.fhirServerUrl,
      session.expiresAt,
      session.verifiedOnly ? 1 : 0,
      session.shareScope ? JSON.stringify(session.shareScope) : null,
      session.writeScope ? JSON.stringify(session.writeScope) : null,
      session.recipientName ?? null,
      session.attestation ? JSON.stringify(session.attestation) : null,
      session.accessCount,
      session.passcodeHash ?? null,
      Date.now(),
    )
  }

  /** Get a session by SHL ID (returns undefined if not found or expired) */
  get(id: string): ShlSession | undefined {
    return this.readSession(this.db.prepare('SELECT * FROM shl_sessions WHERE id = ?').get(id))?.session
  }

  /** Get a session by session token (reverse lookup for FHIR proxy) */
  getByToken(token: string): { id: string; session: ShlSession } | undefined {
    return this.readSession(this.db.prepare('SELECT * FROM shl_sessions WHERE session_token = ?').get(token))
  }

  /** Delete a session by ID (and its access rows) */
  delete(id: string): void {
    this.db.prepare('DELETE FROM shl_sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM shl_accesses WHERE shl_id = ?').run(id)
  }

  /** Delete a session by token (and its access rows) */
  deleteByToken(token: string): void {
    const row = this.db.prepare('SELECT id FROM shl_sessions WHERE session_token = ?').get(token)
    if (Value.Check(IdRow, row)) this.delete(row.id)
  }

  /** Increment total-open count for a session */
  incrementAccessCount(id: string): void {
    this.db.prepare('UPDATE shl_sessions SET access_count = access_count + 1 WHERE id = ?').run(id)
  }

  /**
   * Record an open by a (fingerprinted) recipient/device. A previously-unseen
   * fingerprint is a new distinct device; a repeat increments that device's count.
   */
  recordAccess(id: string, fingerprint: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO shl_accesses (shl_id, fingerprint, first_seen, last_seen, count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(shl_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1
    `).run(id, fingerprint, now, now)
  }

  /** Number of distinct recipients/devices that have opened this SHL. */
  distinctDeviceCount(id: string): number {
    return this.countOf(this.db.prepare('SELECT COUNT(*) as cnt FROM shl_accesses WHERE shl_id = ?').get(id))
  }

  /** Mark that this session's SHL→Consent mirror was successfully written. */
  /**
   * Record the recipient's signature on a session.
   *
   * Write-once: a second attempt is ignored rather than overwriting. The
   * signature is what a later Provenance is built from, so letting a subsequent
   * caller replace it would let whoever holds the link re-attribute writes that
   * were already made under the first signature.
   */
  recordAttestation(id: string, attestation: ShlAttestation): boolean {
    const result = this.db
      .prepare('UPDATE shl_sessions SET attestation = ? WHERE id = ? AND attestation IS NULL')
      .run(JSON.stringify(attestation), id)
    return result.changes > 0
  }

  markConsentMirrored(id: string): void {
    this.db.prepare('UPDATE shl_sessions SET consent_mirrored = 1 WHERE id = ?').run(id)
  }

  /**
   * Active sessions whose Consent mirror has not been confirmed written — the
   * work list for the reconciliation sweep. Bounded by `limit` per pass.
   */
  listUnmirroredActive(limit = 50): { id: string; session: ShlSession }[] {
    return this.db
      .prepare('SELECT * FROM shl_sessions WHERE consent_mirrored = 0 AND expires_at >= ? ORDER BY created_at LIMIT ?')
      .all(Date.now(), limit)
      .flatMap((row) => this.readSession(row) ?? [])
  }

  /** Remove all expired entries (and any now-orphaned access rows) */
  private purgeExpired(): void {
    const result = this.db.prepare('DELETE FROM shl_sessions WHERE expires_at < ?').run(Date.now())
    this.db.prepare('DELETE FROM shl_accesses WHERE shl_id NOT IN (SELECT id FROM shl_sessions)').run()
    if (result.changes > 0) {
      logger.auth.debug('SHL store: purged expired sessions', { count: result.changes })
    }
  }

  /** Get total active session count (for monitoring) */
  count(): number {
    return this.countOf(this.db.prepare('SELECT COUNT(*) as cnt FROM shl_sessions WHERE expires_at >= ?').get(Date.now()))
  }

  private countOf(row: unknown): number {
    return Value.Check(CountRow, row) ? row.cnt : 0
  }

  /** Close the database (for graceful shutdown) */
  close(): void {
    clearInterval(this.cleanupTimer)
    this.db.close()
  }

  /** Undefined when absent, or when the stored row is corrupt: a share whose scope cannot be read must not open. */
  private readSession(raw: unknown): { id: string; session: ShlSession } | undefined {
    if (raw === null || raw === undefined) return undefined
    if (!Value.Check(ShlRow, raw)) {
      logger.auth.warn('SHL store: ignoring a session row with unexpected column types')
      return undefined
    }
    const session = this.rowToSession(raw)
    if (!session) {
      logger.auth.warn('SHL store: ignoring a session whose stored JSON does not match its schema', { id: raw.id })
      return undefined
    }
    return { id: raw.id, session }
  }

  private rowToSession(row: ShlRow): ShlSession | undefined {
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
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const shlSessionStore = new ShlSessionStore()
