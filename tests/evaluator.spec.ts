import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { evaluateTurn } from '../src/evaluator.js'
import type { Config, EvaluationDependencies } from '../src/types.js'

const sessionId = 'session-1' as SessionId
const baseConfig: Config = {
  enabled: true,
  runWhenNoChanges: false,
  reportDir: '.dsh-eval/results',
  maxDiffChars: 10_000,
  maxOutputChars: 2_000,
  rules: [{ id: 'budget', kind: 'max-changed-files', limit: 5 }],
  commands: [{ id: 'unit', kind: 'unit', command: 'pnpm test', required: true }],
}

function dependencies(exitCode: number | null): EvaluationDependencies {
  let tick = 1_700_000_000_000
  return {
    now: () => tick += 10,
    makeRunId: () => 'run-1',
    summary: () => ({
      turn: 2,
      cwd: '/workspace',
      files: [{ path: 'src/index.ts', display: 'src/index.ts', added: 1, deleted: 0 }],
      total: 1,
      added: 1,
      deleted: 0,
    }),
    diff: async () => ({
      kind: 'text',
      path: 'src/index.ts',
      display: 'src/index.ts',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export const answer = 42'] }],
    }),
    runCommand: async () => ({
      exitCode,
      timedOut: false,
      aborted: false,
      stdout: exitCode === 0 ? 'ok' : '',
      stderr: exitCode === 0 ? '' : 'failed',
      outputTruncated: false,
    }),
  }
}

describe('evaluateTurn', () => {
  it('passes when rules and required commands pass', async () => {
    const report = await evaluateTurn(baseConfig, dependencies(0), { sessionId, eventSeq: 8 })
    expect(report.verdict).toBe('passed')
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'passed'])
    expect(report.diffEvidence[0]?.addedLines).toEqual(['export const answer = 42'])
  })

  it('fails when a required command exits nonzero', async () => {
    const report = await evaluateTurn(baseConfig, dependencies(1), { sessionId, eventSeq: 8 })
    expect(report.verdict).toBe('failed')
    expect(report.checks[1]?.exitCode).toBe(1)
  })

  it('does not let a warning rule fail the overall verdict', async () => {
    const config: Config = {
      ...baseConfig,
      rules: [{ id: 'budget', kind: 'max-changed-files', limit: 0, severity: 'warning' }],
      commands: [],
    }
    const report = await evaluateTurn(config, dependencies(0), { sessionId, eventSeq: 8 })
    expect(report.checks[0]?.status).toBe('failed')
    expect(report.verdict).toBe('passed')
  })

  it('skips an empty turn before running commands', async () => {
    let ran = false
    const deps: EvaluationDependencies = {
      ...dependencies(0),
      summary: () => ({ turn: 3, cwd: '/workspace', files: [], total: 0, added: 0, deleted: 0 }),
      runCommand: async () => {
        ran = true
        throw new Error('should not run')
      },
    }
    const report = await evaluateTurn(baseConfig, deps, { sessionId, eventSeq: 9 })
    expect(report.verdict).toBe('skipped')
    expect(ran).toBe(false)
  })

  it('caps added-line evidence with the global diff character budget', async () => {
    const addedLines = Array.from({ length: 100 }, (_, index) => `+line-${index}`)
    const deps: EvaluationDependencies = {
      ...dependencies(0),
      summary: () => ({
        turn: 4,
        cwd: '/workspace',
        files: [{ path: 'src/large.ts', display: 'src/large.ts', added: 100, deleted: 0 }],
        total: 1,
        added: 100,
        deleted: 0,
      }),
      diff: async () => ({
        kind: 'text',
        path: 'src/large.ts',
        display: 'src/large.ts',
        before: true,
        after: true,
        coarse: false,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 100, lines: addedLines }],
      }),
    }
    const report = await evaluateTurn(
      { ...baseConfig, maxDiffChars: 80, rules: [], commands: [] },
      deps,
      { sessionId, eventSeq: 10 },
    )

    expect(report.diffEvidence[0]?.text?.length).toBeLessThanOrEqual(80)
    expect(report.diffEvidence[0]?.addedLines.length).toBeLessThan(100)
    expect(report.diffEvidence[0]?.truncated).toBe(true)
  })

  it('inspects additions starting with ++ and reports actual source lines across hunks', async () => {
    const deps = dependencies(0)
    deps.diff = async () => ({
      kind: 'text', path: 'src/index.ts', display: 'src/index.ts', before: true, after: true, coarse: false,
      hunks: [
        { oldStart: 9, oldLines: 2, newStart: 9, newLines: 3, lines: [' context', '-old', '+++counter', '+debugger'] },
        { oldStart: 30, oldLines: 0, newStart: 31, newLines: 1, lines: ['+debugger', '\\ No newline at end of file'] },
      ],
    })
    const report = await evaluateTurn({
      ...baseConfig, rules: [{ id: 'pattern', kind: 'forbidden-pattern', pattern: 'counter|debugger' }], commands: [],
    }, deps, { sessionId, eventSeq: 8 })
    expect(report.diffEvidence[0]?.addedLines).toEqual(['++counter', 'debugger', 'debugger'])
    expect(report.checks[0]?.findings.map(finding => finding.line)).toEqual([10, 11, 31])
  })

  it('classifies a process without an exit code as an infrastructure error', async () => {
    const report = await evaluateTurn(baseConfig, dependencies(null), { sessionId, eventSeq: 8 })
    expect(report.verdict).toBe('error')
    expect(report.checks[1]?.summary).toMatch(/without an exit code/)
  })

  it.each(['timedOut', 'aborted'] as const)('classifies a %s command as an error', async (flag) => {
    const deps = dependencies(0)
    const run = deps.runCommand
    deps.runCommand = async (...args) => ({ ...await run(...args), [flag]: true })
    const report = await evaluateTurn(baseConfig, deps, { sessionId, eventSeq: 8 })
    expect(report.verdict).toBe('error')
  })

  it('continues after command infrastructure failures and keeps optional checks non-blocking', async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue({
      exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '', outputTruncated: false,
    })
    const report = await evaluateTurn({
      ...baseConfig, commands: [
        { id: 'optional', kind: 'static', command: 'optional', required: false },
        { id: 'required', kind: 'unit', command: 'required' },
      ],
    }, { ...dependencies(0), runCommand }, { sessionId, eventSeq: 8 })
    expect(report.verdict).toBe('passed')
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'error', 'passed'])
  })

  it.each(['diff', 'command'] as const)('rejects cancellation during the last %s instead of returning a completed report', async (stage) => {
    const controller = new AbortController()
    const deps = dependencies(0)
    if (stage === 'diff') {
      const diff = deps.diff
      deps.diff = async (...args) => { controller.abort(); return diff(...args) }
    } else {
      const run = deps.runCommand
      deps.runCommand = async (...args) => { controller.abort(); return run(...args) }
    }
    await expect(evaluateTurn({ ...baseConfig, commands: stage === 'diff' ? [] : baseConfig.commands }, deps, {
      sessionId, eventSeq: 8, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not start checks for a request that was already cancelled', async () => {
    const deps = dependencies(0)
    deps.diff = vi.fn(deps.diff)
    deps.runCommand = vi.fn(deps.runCommand)
    await expect(evaluateTurn(baseConfig, deps, { sessionId, eventSeq: 8, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(deps.diff).not.toHaveBeenCalled()
    expect(deps.runCommand).not.toHaveBeenCalled()
  })
})
