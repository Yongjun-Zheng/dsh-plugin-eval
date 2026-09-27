export interface SequencedJob {
  eventSeq: number
}

/** Per-key FIFO queues that retain every distinct event sequence. */
export class PendingJobs<Key, Job extends SequencedJob> {
  private readonly queues = new Map<Key, Job[]>()
  private readonly lastEnqueued = new Map<Key, number>()

  enqueue(key: Key, job: Job): boolean {
    const lastEventSeq = this.lastEnqueued.get(key)
    if (lastEventSeq !== undefined && job.eventSeq <= lastEventSeq) return false
    this.lastEnqueued.set(key, job.eventSeq)
    const queue = this.queues.get(key)
    if (queue === undefined) {
      this.queues.set(key, [job])
      return true
    }
    queue.push(job)
    return true
  }

  dequeue(key: Key): Job | undefined {
    const queue = this.queues.get(key)
    if (queue === undefined) return undefined
    const job = queue.shift()
    if (queue.length === 0) this.queues.delete(key)
    return job
  }

  has(key: Key): boolean {
    return (this.queues.get(key)?.length ?? 0) > 0
  }

  delete(key: Key): void {
    this.queues.delete(key)
    this.lastEnqueued.delete(key)
  }
}
