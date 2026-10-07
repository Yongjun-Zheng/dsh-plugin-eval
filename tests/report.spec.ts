import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistReport } from '../src/report.js'
import type { EvaluationReport } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const inside = relative(resolve(tmpdir()), root)
    if (isAbsolute(inside) || inside.startsWith(`..${sep}`) || !inside.startsWith('dsh-eval-report-test-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<EvaluationReport> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-eval-report-test-'))
  roots.push(cwd)
  return {
    schemaVersion: 1, runId: 'run-1', sessionId: 'session-1', turn: 2, eventSeq: 8,
    startedAt: '2026-10-07T00:00:00.000Z', finishedAt: '2026-10-07T00:00:00.000Z', durationMs: 0,
    verdict: 'passed', summary: { cwd, turn: 2, files: [], total: 0, added: 0, deleted: 0 }, checks: [], diffEvidence: [],
  }
}

describe('report persistence on disk', () => {
  it('writes a complete JSON report with its artifact path and leaves no temporary file', async () => {
    const report = await fixture()
    const persisted = await persistReport('.dsh-eval/results', report)
    const directory = join(report.summary.cwd, '.dsh-eval/results', report.sessionId)
    expect(persisted.artifactPath).toBe(join(directory, 'turn-2-run-1.json'))
    expect(JSON.parse(await readFile(persisted.artifactPath!, 'utf8'))).toEqual(persisted)
    expect(await readdir(directory)).toEqual(['turn-2-run-1.json'])
    expect(report.artifactPath).toBeUndefined()
  })

  it('cleans its temporary file when atomic publication fails', async () => {
    const report = await fixture()
    const directory = join(report.summary.cwd, '.dsh-eval/results', report.sessionId)
    const conflictingPath = join(directory, 'turn-2-run-1.json')
    await mkdir(conflictingPath, { recursive: true })
    await expect(persistReport('.dsh-eval/results', report)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['turn-2-run-1.json'])
    expect((await stat(conflictingPath)).isDirectory()).toBe(true)
  })

  it('keeps reports from overlapping runs distinct', async () => {
    const report = await fixture()
    const runs = await Promise.all(['run-a', 'run-b'].map(runId => persistReport('results', { ...report, runId })))
    expect(new Set(runs.map(run => run.artifactPath)).size).toBe(2)
    for (const run of runs) expect(JSON.parse(await readFile(run.artifactPath!, 'utf8'))).toEqual(run)
  })
})
