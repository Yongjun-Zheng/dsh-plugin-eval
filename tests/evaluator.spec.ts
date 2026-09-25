import { describe, expect, it } from 'vitest'
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
})
