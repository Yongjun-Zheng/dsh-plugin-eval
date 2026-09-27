import { describe, expect, it } from 'vitest'
import { PendingJobs } from '../src/pending-jobs.js'

describe('PendingJobs', () => {
  it('retains every queued turn in FIFO order', () => {
    const pending = new PendingJobs<string, { eventSeq: number; turn: number }>()
    pending.enqueue('session-1', { eventSeq: 10, turn: 1 })
    pending.enqueue('session-1', { eventSeq: 20, turn: 2 })
    pending.enqueue('session-1', { eventSeq: 30, turn: 3 })

    expect(pending.dequeue('session-1')?.turn).toBe(1)
    expect(pending.dequeue('session-1')?.turn).toBe(2)
    expect(pending.dequeue('session-1')?.turn).toBe(3)
    expect(pending.has('session-1')).toBe(false)
  })

  it('deduplicates the same event sequence within a Session', () => {
    const pending = new PendingJobs<string, { eventSeq: number; turn: number }>()
    expect(pending.enqueue('session-1', { eventSeq: 10, turn: 1 })).toBe(true)
    expect(pending.enqueue('session-1', { eventSeq: 10, turn: 1 })).toBe(false)
    expect(pending.dequeue('session-1')).toEqual({ eventSeq: 10, turn: 1 })
    expect(pending.enqueue('session-1', { eventSeq: 10, turn: 1 })).toBe(false)
    expect(pending.dequeue('session-1')).toBeUndefined()
  })
})
