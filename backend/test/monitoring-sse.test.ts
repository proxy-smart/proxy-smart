// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { createSseStream, type SseSource } from '../src/routes/monitoring/sse'

function countingSource() {
  const state = { subscribed: 0, unsubscribed: 0, emit: (_payload: string) => {} }
  const source: SseSource<string> = {
    subscribe: (emit) => {
      state.subscribed++
      state.emit = emit
      return () => { state.unsubscribed++ }
    },
    initial: () => ({ type: 'snapshot' }),
  }
  return { source, state }
}

const decoder = new TextDecoder()

describe('createSseStream', () => {
  it('sends the initial frame and then what the source publishes', async () => {
    const { source, state } = countingSource()
    const reader = createSseStream(source).getReader()
    state.emit('hello')
    const first = await reader.read()
    const second = await reader.read()
    expect(decoder.decode(first.value)).toBe('data: {"type":"snapshot"}\n\n')
    expect(decoder.decode(second.value)).toBe('data: "hello"\n\n')
    await reader.cancel()
  })

  it('unsubscribes as soon as the client goes away', async () => {
    const { source, state } = countingSource()
    const stream = createSseStream(source)
    expect(state.subscribed).toBe(1)
    await stream.cancel()
    expect(state.unsubscribed).toBe(1)
  })

  it('unsubscribes once even when cancelled and then published to', async () => {
    const { source, state } = countingSource()
    const stream = createSseStream(source)
    await stream.cancel()
    state.emit('late')
    expect(state.unsubscribed).toBe(1)
  })
})
