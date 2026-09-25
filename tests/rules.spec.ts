import { describe, expect, it } from 'vitest'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import { evaluateRule, globToRegExp } from '../src/rules.js'
import type { DiffEvidence } from '../src/types.js'

const summary: WorkspaceChangesSummary = {
  turn: 1,
  cwd: '/workspace',
  files: [
    { path: 'src/index.ts', display: 'src/index.ts', added: 2, deleted: 1 },
    { path: 'pnpm-lock.yaml', display: 'pnpm-lock.yaml', added: 1, deleted: 0 },
  ],
  total: 2,
  added: 3,
  deleted: 1,
}

const evidence: DiffEvidence[] = [{
  path: 'src/index.ts',
  display: 'src/index.ts',
  kind: 'text',
  text: '+const debug = true',
  addedLines: ['const debug = true', 'debugger'],
  truncated: false,
}, {
  path: 'pnpm-lock.yaml',
  display: 'pnpm-lock.yaml',
  kind: 'text',
  text: '+lockfileVersion: 9',
  addedLines: ['lockfileVersion: 9'],
  truncated: false,
}]

describe('globToRegExp', () => {
  it('supports star, double-star, question mark, and Windows separators', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true)
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src\\**').test('src/a/b.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
  })
})
describe('evaluateRule', () => {
  it('rejects forbidden changed paths', () => {
    const result = evaluateRule({ id: 'lockfile', kind: 'forbidden-path', paths: ['pnpm-lock.yaml'] }, summary, evidence)
    expect(result.status).toBe('failed')
    expect(result.findings[0]?.path).toBe('pnpm-lock.yaml')
  })

  it('checks only added lines for forbidden patterns', () => {
    const result = evaluateRule({ id: 'debugger', kind: 'forbidden-pattern', pattern: '\\bdebugger\\b' }, summary, evidence)
    expect(result.status).toBe('failed')
    expect(result.findings).toHaveLength(1)
  })

  it('keeps warning rules non-blocking', () => {
    const result = evaluateRule({ id: 'budget', kind: 'max-diff-lines', limit: 1, severity: 'warning' }, summary, evidence)
    expect(result.status).toBe('failed')
    expect(result.required).toBe(false)
  })

  it('fails content rules closed when evidence was truncated', () => {
    const result = evaluateRule(
      { id: 'pattern', kind: 'forbidden-pattern', pattern: 'secret' },
      summary,
      [{ ...evidence[0]!, truncated: true }, evidence[1]!],
    )
    expect(result.status).toBe('error')
  })
})
