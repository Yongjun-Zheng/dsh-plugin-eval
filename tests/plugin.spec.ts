import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import plugin from '../src/index.js'
import { persistReport } from '../src/report.js'
import type { Config, EvaluationReport } from '../src/types.js'

vi.mock('../src/report.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/report.js')>(),
  persistReport: vi.fn(),
}))

const cleanups: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.mocked(persistReport).mockReset().mockImplementation(async (_directory, report) => ({ ...report, artifactPath: 'report.json' }))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(config: Partial<Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agents = new Map<SessionId, Agent>()
  const completed: EvaluationReport[] = []
  const summary = vi.fn((_id: SessionId, seq: number): WorkspaceChangesSummary => ({
    turn: seq, cwd: process.cwd(), total: 0, added: 0, deleted: 0, files: [],
  }))
  const output = { text: 'ok', truncated: false }
  const execute = vi.fn(async (_spec: { signal?: AbortSignal }) => ({
    result: async () => ({ exitCode: 0, timedOut: false, aborted: false, stdout: output, stderr: output }),
  }))
  const resolve = vi.fn((spec: unknown) => spec)
  ctx.provide('agents', { get: (id: SessionId) => agents.get(id) } as Context['agents'])
  ctx.provide('workspaceChanges', { summary, diff: vi.fn() })
  ctx.provide('shell', { resolve, execute } as unknown as Context['shell'])
  ctx.on('agent-eval/completed', report => { completed.push(report) })
  const fiber = await ctx.plugin(plugin, {
    runWhenNoChanges: true,
    commands: [{ id: 'test', kind: 'unit', command: 'test' }],
    ...config,
  } as Config)
  const service = ctx.agentEvaluator
  const session = { id: 'session-1' as SessionId } as Session
  const whenIdle = vi.fn(async () => {})
  const maintenance = vi.fn<Agent['runMaintenance']>(task => task(new AbortController().signal))
  agents.set(session.id, { session, whenIdle, runMaintenance: maintenance } as unknown as Agent)
  const announce = (seq: number, target = session) => {
    ctx.emit('session/event', target, { type: 'workspace/changes', seq, data: { turn: seq } } as never)
  }
  return { ctx, fiber, session, service, agents, summary, execute, resolve, whenIdle, maintenance, announce, completed }
}

describe('plugin lifecycle with Cordis', () => {
  it('waits for idle, preserves queued turns in order, and ignores duplicate events', async () => {
    const h = await boot()
    const idle = Promise.withResolvers<void>()
    h.whenIdle.mockReturnValue(idle.promise)
    h.announce(1)
    h.announce(2)
    h.announce(2)
    h.announce(3)
    await vi.waitFor(() => expect(h.whenIdle).toHaveBeenCalled())
    expect(h.execute).not.toHaveBeenCalled()
    idle.resolve()
    await vi.waitFor(() => expect(h.completed).toHaveLength(3))
    expect(h.completed.map(report => report.eventSeq)).toEqual([1, 2, 3])
    expect(h.execute).toHaveBeenCalledTimes(3)
    expect(h.service.latest(h.session.id)?.eventSeq).toBe(3)
    expect(h.service.latest(h.session.id)?.artifactPath).toBe('report.json')
  })

  it('retries maintenance admission races before running the checks', async () => {
    const h = await boot()
    h.maintenance.mockImplementationOnce(() => { throw new Error('agent already has active work') })
    h.announce(1)
    await vi.waitFor(() => expect(h.completed).toHaveLength(1))
    expect(h.maintenance).toHaveBeenCalledTimes(2)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('does not repeat checks when an admitted task fails with an active-work message', async () => {
    const h = await boot()
    vi.mocked(persistReport).mockRejectedValueOnce(new Error('storage already has active work'))
    h.announce(1)
    h.announce(2)
    await vi.waitFor(() => expect(h.completed).toHaveLength(1))
    expect(h.completed[0]?.eventSeq).toBe(2)
    expect(h.execute).toHaveBeenCalledTimes(2)
    expect(h.maintenance).toHaveBeenCalledTimes(2)
  })

  it('unloads promptly while the agent never reaches idle', async () => {
    const h = await boot()
    h.whenIdle.mockReturnValue(new Promise(() => {}))
    h.announce(1)
    h.announce(2)
    await vi.waitFor(() => expect(h.whenIdle).toHaveBeenCalled())
    await h.fiber.dispose()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.completed).toHaveLength(0)
  })

  it.each(['automatic', 'explicit'] as const)('cancels %s commands and drains them before unload completes', async (mode) => {
    const h = await boot()
    const started = Promise.withResolvers<AbortSignal>()
    const settled = Promise.withResolvers<void>()
    h.execute.mockImplementation(async spec => ({ result: async () => {
      started.resolve(spec.signal!)
      await settled.promise
      return { exitCode: 0, timedOut: false, aborted: true, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    } }))
    let request: Promise<void> | undefined
    if (mode === 'automatic') {
      h.announce(1)
      h.announce(2)
    } else {
      request = expect(h.service.evaluate({ sessionId: h.session.id, eventSeq: 1 })).rejects.toMatchObject({ name: 'AbortError' })
    }
    const signal = await started.promise
    let disposed = false
    const disposal = h.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(disposed).toBe(false)
    settled.resolve()
    await disposal
    await request
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(persistReport).not.toHaveBeenCalled()
    expect(h.completed).toHaveLength(0)
  })

  it('cancels a disposed session and allows a fresh session with the same id', async () => {
    const h = await boot()
    h.whenIdle.mockReturnValueOnce(new Promise(() => {}))
    h.announce(10)
    h.announce(20)
    await vi.waitFor(() => expect(h.whenIdle).toHaveBeenCalled())
    h.ctx.emit('session/disposed', h.session)
    const replacement = { id: h.session.id } as Session
    h.agents.set(replacement.id, { session: replacement, whenIdle: h.whenIdle, runMaintenance: h.maintenance } as unknown as Agent)
    h.announce(1, replacement)
    await vi.waitFor(() => expect(h.completed).toHaveLength(1))
    expect(h.completed[0]?.eventSeq).toBe(1)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['automatic', 'explicit'] as const)('aborts an %s command on session disposal without publishing a completed report', async (mode) => {
    const h = await boot()
    const started = Promise.withResolvers<AbortSignal>()
    h.execute.mockImplementation(async spec => ({ result: async () => {
      started.resolve(spec.signal!)
      await new Promise<void>(resolve => spec.signal!.addEventListener('abort', () => resolve(), { once: true }))
      return { exitCode: 0, timedOut: false, aborted: true, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    } }))
    let request: Promise<void> | undefined
    if (mode === 'automatic') h.announce(1)
    else request = expect(h.service.evaluate({ sessionId: h.session.id, eventSeq: 1 })).rejects.toMatchObject({ name: 'AbortError' })
    const signal = await started.promise
    h.ctx.emit('session/disposed', h.session)
    expect(signal.aborted).toBe(true)
    await h.fiber.dispose()
    await request
    expect(persistReport).not.toHaveBeenCalled()
    expect(h.completed).toHaveLength(0)
  })

  it('releases cached reports when their session is disposed', async () => {
    const h = await boot()
    h.announce(1)
    await vi.waitFor(() => expect(h.completed).toHaveLength(1))
    expect(h.service.latest(h.session.id)).toBeDefined()
    h.ctx.emit('session/disposed', h.session)
    expect(h.service.latest(h.session.id)).toBeUndefined()
  })

  it('applies plugin lifetime cancellation to explicit evaluate calls too', async () => {
    const h = await boot()
    await h.fiber.dispose()
    await expect(h.service.evaluate({ sessionId: h.session.id, eventSeq: 1 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('bounds stdout and stderr independently and preserves shell truncation flags', async () => {
    const h = await boot({ maxOutputChars: 3 })
    h.execute.mockResolvedValue({ result: async () => ({
      exitCode: 0, timedOut: false, aborted: false,
      stdout: { text: 'abcdef', truncated: false }, stderr: { text: 'x', truncated: true },
    }) })
    h.announce(1)
    await vi.waitFor(() => expect(h.completed).toHaveLength(1))
    expect(h.completed[0]?.checks[0]).toMatchObject({ stdout: 'def', stderr: 'x', outputTruncated: true })
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ stdoutMaxBytes: 12, timeoutMs: 120_000, workdir: process.cwd() }))
  })

  it('disables automatic evaluation while keeping the explicit service available', async () => {
    const h = await boot({ enabled: false })
    h.announce(1)
    await h.service.evaluate({ sessionId: h.session.id, eventSeq: 2 })
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.completed).toHaveLength(0)
    expect(h.service.latest(h.session.id)?.eventSeq).toBe(2)
  })
})
