// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// The JSONL journal every events logger shares, driven through a concrete journal over a temp directory.

import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { t } from 'elysia'
import { EventJournal, type JournalEvent } from '../src/lib/events/journal'
import { matchesSchema } from '../src/lib/type-guards'
import { bucketByHour, countBy, percent, tallyBy, topEntries } from '../src/lib/events/aggregate'
import { freshStamp, randomSuffix, withDisposableDir, writeJsonl, writeLog } from './helpers/jsonl-log'

interface TestEvent extends JournalEvent {
  kind: string
  ok: boolean
  clientId?: string
}

const TestEventSchema = t.Object({
  id: t.String(),
  timestamp: t.String(),
  kind: t.String(),
  ok: t.Boolean(),
  clientId: t.Optional(t.String()),
})

interface TestAnalytics {
  total: number
  successRate: number
  byKind: Record<string, number>
  topClients: Array<[string, number]>
  hourlyStats: Array<{ hour: string; ok: number; failed: number }>
}

interface JournalOverrides {
  ringBufferSize?: number
  loadWindowMs?: number
  analyticsWindowMs?: number
  analyticsFilename?: string
}

class TestJournal extends EventJournal<TestEvent, TestAnalytics> {
  constructor(logDir: string, overrides: JournalOverrides = {}) {
    super({
      logSubdir: 'unused',
      logFilename: 'events.jsonl',
      idPrefix: 'test',
      channel: { error() {}, warn() {}, info() {}, debug() {} },
      isEvent: matchesSchema(TestEventSchema),
      logDir,
      ...overrides,
    })
  }

  async write(data: Omit<TestEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.record({ ...data, ...this.stamp() })
  }

  find(opts?: { limit?: number; since?: Date; kind?: string; clientId?: string }): TestEvent[] {
    return this.selectEvents(
      opts,
      event => !opts?.kind || event.kind === opts.kind,
      event => !opts?.clientId || event.clientId === opts.clientId,
    )
  }

  protected computeAnalytics(recent: TestEvent[]): TestAnalytics {
    return {
      total: recent.length,
      successRate: percent(recent.filter(event => event.ok).length, recent.length, { round: true }),
      byKind: countBy(recent, event => event.kind),
      topClients: topEntries(tallyBy(recent, event => event.clientId)),
      hourlyStats: bucketByHour(
        recent,
        () => ({ ok: 0, failed: 0 }),
        (bucket, event) => {
          if (event.ok) bucket.ok++
          else bucket.failed++
        },
      ),
    }
  }
}

/** Run a body against a throwaway log directory, removed afterwards. */
function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  return withDisposableDir(join(tmpdir(), `journal-${randomSuffix()}`), body)
}

/** As withDir, with an initialized journal over that directory. */
async function withJournal(
  overrides: JournalOverrides,
  body: (journal: TestJournal, dir: string) => Promise<void>,
): Promise<void> {
  await withDir(async dir => {
    const journal = new TestJournal(dir, overrides)
    await journal.initialize()
    await body(journal, dir)
  })
}

function event(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    ...freshStamp(),
    kind: 'login',
    ok: true,
    ...overrides,
  }
}

/** The three-event fixture the query cases share. */
async function withSeededJournal(body: (journal: TestJournal) => void): Promise<void> {
  await withDir(async dir => {
    writeJsonl(dir, [
      event({ id: 'a', kind: 'login', clientId: 'app-a', timestamp: '2026-09-04T10:00:00.000Z' }),
      event({ id: 'b', kind: 'logout', clientId: 'app-b', timestamp: '2026-09-04T11:00:00.000Z' }),
      event({ id: 'c', kind: 'login', clientId: 'app-b', timestamp: '2026-09-04T12:00:00.000Z' }),
    ])
    const journal = new TestJournal(dir)
    await journal.initialize()
    body(journal)
  })
}

describe('EventJournal', () => {
  describe('write path', () => {
    it('appends to the JSONL log and the ring buffer', async () => {
      await withJournal({}, async (journal, dir) => {
        await journal.write({ kind: 'login', ok: true })

        const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n')
        expect(lines.length).toBe(1)
        expect(journal.getRecentEvents().length).toBe(1)
        expect(journal.getEventCount()).toBe(1)
      })
    })

    it('stamps an id carrying the configured prefix', async () => {
      await withJournal({}, async journal => {
        await journal.write({ kind: 'login', ok: true })
        expect(journal.getRecentEvents()[0].id.startsWith('test-')).toBe(true)
      })
    })

    it('keeps newest first and caps at the ring buffer size', async () => {
      await withJournal({ ringBufferSize: 3 }, async journal => {
        for (const kind of ['a', 'b', 'c', 'd']) {
          await journal.write({ kind, ok: true })
        }

        expect(journal.getRecentEvents().map(e => e.kind)).toEqual(['d', 'c', 'b'])
        expect(journal.getEventCapacity()).toBe(3)
      })
    })

    it('notifies event subscribers, and a throwing subscriber does not break the write', async () => {
      await withJournal({}, async journal => {
        const seen: string[] = []
        journal.subscribe(() => { throw new Error('subscriber blew up') })
        const unsubscribe = journal.subscribe(e => seen.push(e.kind))

        await journal.write({ kind: 'login', ok: true })
        unsubscribe()
        await journal.write({ kind: 'logout', ok: true })

        expect(seen).toEqual(['login'])
        expect(journal.getEventCount()).toBe(2)
      })
    })
  })

  describe('analytics', () => {
    it('refreshes and publishes analytics on every write', async () => {
      await withJournal({}, async journal => {
        const updates: number[] = []
        journal.subscribeAnalytics(analytics => updates.push(analytics.total))

        await journal.write({ kind: 'login', ok: true, clientId: 'app-a' })
        await journal.write({ kind: 'login', ok: false, clientId: 'app-a' })

        expect(updates).toEqual([1, 2])
        const analytics = journal.getAnalytics()
        expect(analytics?.total).toBe(2)
        expect(analytics?.successRate).toBe(50)
        expect(analytics?.byKind).toEqual({ login: 2 })
        expect(analytics?.topClients).toEqual([['app-a', 2]])
      })
    })

    it('excludes events older than the analytics window', async () => {
      await withDir(async dir => {
        writeJsonl(dir, [
          event({ id: 'old', timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }),
          event({ id: 'fresh' }),
        ])
        const journal = new TestJournal(dir)
        await journal.initialize()

        expect(journal.getRecentEvents().length).toBe(2)
        expect(journal.getAnalytics()?.total).toBe(1)
      })
    })

    it('snapshots analytics to disk when a filename is configured', async () => {
      await withJournal({ analyticsFilename: 'analytics.json' }, async (journal, dir) => {
        await journal.write({ kind: 'login', ok: true })

        const snapshot: TestAnalytics = JSON.parse(readFileSync(join(dir, 'analytics.json'), 'utf8'))
        expect(snapshot.total).toBe(1)
      })
    })

    it('buckets by sparse UTC hour, oldest hour first', async () => {
      await withDir(async dir => {
        writeJsonl(dir, [
          event({ timestamp: '2026-09-04T11:30:00.000Z', ok: false }),
          event({ timestamp: '2026-09-04T10:15:00.000Z', ok: true }),
          event({ timestamp: '2026-09-04T10:45:00.000Z', ok: true }),
        ])
        const journal = new TestJournal(dir, { analyticsWindowMs: Number.MAX_SAFE_INTEGER })
        await journal.initialize()

        expect(journal.getAnalytics()?.hourlyStats).toEqual([
          { hour: '2026-09-04T10:00:00.000Z', ok: 2, failed: 0 },
          { hour: '2026-09-04T11:00:00.000Z', ok: 0, failed: 1 },
        ])
      })
    })
  })

  describe('bootstrap from disk', () => {
    it('loads persisted events newest first', async () => {
      await withDir(async dir => {
        writeJsonl(dir, [
          event({ id: 'older', timestamp: '2026-09-04T10:00:00.000Z' }),
          event({ id: 'newer', timestamp: '2026-09-04T12:00:00.000Z' }),
        ])
        const journal = new TestJournal(dir)
        await journal.initialize()

        expect(journal.getRecentEvents().map(e => e.id)).toEqual(['newer', 'older'])
      })
    })

    it('skips corrupt lines rather than failing the load', async () => {
      await withDir(async dir => {
        writeLog(dir, `${JSON.stringify(event({ id: 'good' }))}\nnot-json\n\n`)
        const journal = new TestJournal(dir)
        await journal.initialize()

        expect(journal.getRecentEvents().map(e => e.id)).toEqual(['good'])
      })
    })

    it('skips persisted lines that are JSON but not an event of this journal', async () => {
      await withDir(async dir => {
        const { ok: _ok, ...withoutOutcome } = event({ id: 'no-outcome' })
        writeJsonl(dir, [event({ id: 'good' }), withoutOutcome, { ...event({ id: 'wrong-type' }), ok: 'yes' }])
        const journal = new TestJournal(dir)
        await journal.initialize()

        expect(journal.getRecentEvents().map(e => e.id)).toEqual(['good'])
      })
    })

    it('drops events older than the load window', async () => {
      await withDir(async dir => {
        writeJsonl(dir, [
          event({ id: 'ancient', timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
          event({ id: 'recent' }),
        ])
        const journal = new TestJournal(dir, { loadWindowMs: 60 * 1000 })
        await journal.initialize()

        expect(journal.getRecentEvents().map(e => e.id)).toEqual(['recent'])
      })
    })

    it('starts empty when no log file exists, and initializes only once', async () => {
      await withJournal({}, async journal => {
        expect(journal.getRecentEvents()).toEqual([])
        await journal.write({ kind: 'login', ok: true })
        await journal.initialize()

        expect(journal.getEventCount()).toBe(1)
      })
    })
  })

  describe('query API', () => {
    it('filters by a domain predicate', async () => {
      await withSeededJournal(journal => {
        expect(journal.find({ kind: 'login' }).map(e => e.id)).toEqual(['c', 'a'])
        expect(journal.find({ clientId: 'app-b' }).map(e => e.id)).toEqual(['c', 'b'])
      })
    })

    it('applies the limit after the filters, not before', async () => {
      await withSeededJournal(journal => {
        // A limit applied first would take 'c' and then filter it away.
        expect(journal.find({ clientId: 'app-a', limit: 1 }).map(e => e.id)).toEqual(['a'])
      })
    })

    it('filters by since', async () => {
      await withSeededJournal(journal => {
        const since = new Date('2026-09-04T11:00:00.000Z')
        expect(journal.find({ since }).map(e => e.id)).toEqual(['c', 'b'])
      })
    })

    it('hands back a copy, so a caller cannot mutate the ring buffer', async () => {
      await withSeededJournal(journal => {
        journal.getRecentEvents().pop()
        expect(journal.getRecentEvents().length).toBe(3)
      })
    })
  })
})
