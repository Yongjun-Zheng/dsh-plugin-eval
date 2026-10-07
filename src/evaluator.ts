import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes'
import { evaluateRule } from './rules.js'
import type {
  CheckResult, CommandConfig, Config, DiffEvidence, EvaluationDependencies, EvaluationReport, EvaluationRequest,
} from './types.js'

function abortError(): Error {
  const error = new Error('Evaluation aborted')
  error.name = 'AbortError'
  return error
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function* renderedDiffLines(diff: Extract<WorkspaceFileDiff, { kind: 'text' }>): Generator<{ text: string; addedLine?: number }> {
  yield { text: `--- a/${diff.display}` }
  yield { text: `+++ b/${diff.display}` }
  for (const hunk of diff.hunks) {
    yield { text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` }
    let lineNumber = hunk.newStart
    for (const text of hunk.lines) {
      yield text.startsWith('+') ? { text, addedLine: lineNumber } : { text }
      if (text.startsWith('+') || text.startsWith(' ')) lineNumber += 1
    }
  }
}

function renderDiffWithinLimit(
  diff: Extract<WorkspaceFileDiff, { kind: 'text' }>,
  limit: number,
): { text: string; addedLines: string[]; addedLineNumbers: number[]; truncated: boolean } {
  const parts: string[] = []
  const addedLines: string[] = []
  const addedLineNumbers: number[] = []
  let used = 0
  let first = true
  for (const line of renderedDiffLines(diff)) {
    const chunk = `${first ? '' : '\n'}${line.text}`
    const available = Math.max(0, limit - used)
    if (chunk.length > available) {
      if (available > 0) parts.push(chunk.slice(0, available))
      return { text: parts.join(''), addedLines, addedLineNumbers, truncated: true }
    }
    parts.push(chunk)
    used += chunk.length
    first = false
    if (line.addedLine !== undefined) {
      addedLines.push(line.text.slice(1))
      addedLineNumbers.push(line.addedLine)
    }
  }
  return { text: parts.join(''), addedLines, addedLineNumbers, truncated: false }
}

async function collectEvidence(
  deps: EvaluationDependencies,
  request: EvaluationRequest,
  fileCount: number,
  maxDiffChars: number,
  signal: AbortSignal,
): Promise<DiffEvidence[]> {
  const evidence: DiffEvidence[] = []
  let remaining = maxDiffChars
  for (let index = 0; index < fileCount; index += 1) {
    throwIfAborted(signal)
    const diff = await deps.diff(request.sessionId, request.eventSeq, index, signal)
    throwIfAborted(signal)
    if (diff === undefined) {
      evidence.push({ path: `unknown-${index}`, display: `unknown-${index}`, kind: 'oversized', addedLines: [], truncated: true })
      continue
    }
    if (diff.kind !== 'text') {
      evidence.push({ path: diff.path, display: diff.display, kind: diff.kind, addedLines: [], truncated: false })
      continue
    }
    const rendered = renderDiffWithinLimit(diff, remaining)
    remaining -= rendered.text.length
    evidence.push({
      path: diff.path,
      display: diff.display,
      kind: 'text',
      text: rendered.text,
      addedLines: rendered.addedLines,
      addedLineNumbers: rendered.addedLineNumbers,
      truncated: rendered.truncated,
    })
  }
  return evidence
}

async function runCommandCheck(
  deps: EvaluationDependencies,
  command: CommandConfig,
  cwd: string,
  signal: AbortSignal,
  now: () => number,
): Promise<CheckResult> {
  const started = now()
  try {
    const execution = await deps.runCommand(command, cwd, signal)
    const status: CheckResult['status'] = execution.timedOut || execution.aborted || execution.exitCode === null
      ? 'error'
      : execution.exitCode === 0 ? 'passed' : 'failed'
    return {
      id: command.id,
      kind: command.kind,
      status,
      required: command.required ?? true,
      durationMs: Math.max(0, now() - started),
      summary: execution.timedOut
        ? `Command timed out after ${command.timeoutMs ?? 120_000} ms.`
        : execution.aborted
          ? 'Command was aborted.'
          : execution.exitCode === null
            ? 'Command terminated without an exit code.'
            : `Command exited with code ${execution.exitCode}.`,
      findings: [],
      command: command.command,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      aborted: execution.aborted,
      stdout: execution.stdout,
      stderr: execution.stderr,
      outputTruncated: execution.outputTruncated,
    }
  } catch (error: unknown) {
    return {
      id: command.id,
      kind: command.kind,
      status: 'error',
      required: command.required ?? true,
      durationMs: Math.max(0, now() - started),
      summary: `Command infrastructure failed: ${error instanceof Error ? error.message : String(error)}`,
      findings: [{ code: 'command-infrastructure', message: error instanceof Error ? error.message : String(error) }],
      command: command.command,
    }
  }
}

function verdictOf(checks: readonly CheckResult[], skipped: boolean): EvaluationReport['verdict'] {
  if (skipped) return 'skipped'
  if (checks.some(check => check.required && check.status === 'error')) return 'error'
  if (checks.some(check => check.required && check.status === 'failed')) return 'failed'
  return 'passed'
}

export async function evaluateTurn(
  config: Config,
  deps: EvaluationDependencies,
  request: EvaluationRequest,
): Promise<EvaluationReport> {
  const now = deps.now ?? Date.now
  const started = now()
  const summary = deps.summary(request.sessionId, request.eventSeq)
  if (summary === undefined) throw new Error(`No workspace change summary for event ${request.eventSeq}`)
  const signal = request.signal ?? new AbortController().signal
  throwIfAborted(signal)

  const skipped = summary.total === 0 && !config.runWhenNoChanges
  const evidence = skipped ? [] : await collectEvidence(deps, request, summary.files.length, config.maxDiffChars, signal)
  const checks: CheckResult[] = skipped
    ? []
    : config.rules.map(rule => evaluateRule(rule, summary, evidence))

  if (!skipped) {
    for (const command of config.commands) {
      throwIfAborted(signal)
      checks.push(await runCommandCheck(deps, command, summary.cwd, signal, now))
      throwIfAborted(signal)
    }
  }

  const finished = now()
  return {
    schemaVersion: 1,
    runId: deps.makeRunId?.() ?? randomUUID(),
    sessionId: request.sessionId as string,
    turn: summary.turn,
    eventSeq: request.eventSeq,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    verdict: verdictOf(checks, skipped),
    summary,
    checks,
    diffEvidence: evidence,
  }
}

export function createEvaluator(config: Config, deps: EvaluationDependencies): {
  evaluate(request: EvaluationRequest): Promise<EvaluationReport>
  latest(sessionId: SessionId): EvaluationReport | undefined
  remember(report: EvaluationReport): void
  forget(sessionId: SessionId): void
  clear(): void
} {
  const latest = new Map<SessionId, EvaluationReport>()
  return {
    evaluate: request => evaluateTurn(config, deps, request),
    latest: sessionId => latest.get(sessionId),
    remember: report => { latest.set(report.sessionId as SessionId, report) },
    forget: sessionId => { latest.delete(sessionId) },
    clear: () => { latest.clear() },
  }
}
