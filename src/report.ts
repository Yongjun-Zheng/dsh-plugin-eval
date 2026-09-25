import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { EvaluationReport } from './types.js'

function safeSegment(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/gu, '_')
  return sanitized.length > 0 ? sanitized : 'unknown'
}
export function validateReportDir(reportDir: string): void {
  if (reportDir.trim() === '') throw new Error('reportDir must not be empty')
  if (isAbsolute(reportDir)) throw new Error('reportDir must be relative to the evaluated workspace')
  const normalized = reportDir.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) throw new Error('reportDir must stay inside the evaluated workspace')
}

export async function persistReport(reportDir: string, report: EvaluationReport): Promise<EvaluationReport> {
  validateReportDir(reportDir)
  const root = resolve(report.summary.cwd)
  const directory = resolve(root, reportDir, safeSegment(report.sessionId))
  const check = relative(root, directory)
  if (check === '..' || check.startsWith(`..${sep}`) || isAbsolute(check)) {
    throw new Error('Resolved report directory escaped the evaluated workspace')
  }
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, `turn-${report.turn}-${safeSegment(report.runId)}.json`)
  const complete: EvaluationReport = { ...report, artifactPath: path }
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(complete, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return complete
}
