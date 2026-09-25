import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes'

export type RuleKind =
  | 'forbidden-path'
  | 'required-path'
  | 'forbidden-pattern'
  | 'required-pattern'
  | 'max-changed-files'
  | 'max-diff-lines'

export type RuleSeverity = 'error' | 'warning'
export type CommandKind = 'static' | 'unit' | 'e2e'
export type CheckStatus = 'passed' | 'failed' | 'error' | 'skipped'
export type EvaluationVerdict = 'passed' | 'failed' | 'error' | 'skipped'

export interface RuleConfig {
  id: string
  kind: RuleKind
  paths?: string[]
  pattern?: string
  flags?: string
  limit?: number
  severity?: RuleSeverity
}
export interface CommandConfig {
  id: string
  kind: CommandKind
  command: string
  timeoutMs?: number
  required?: boolean
}

export interface Config {
  enabled: boolean
  runWhenNoChanges: boolean
  reportDir: string
  maxDiffChars: number
  maxOutputChars: number
  rules: RuleConfig[]
  commands: CommandConfig[]
}

export interface Finding {
  code: string
  message: string
  path?: string
  line?: number
}

export interface CheckResult {
  id: string
  kind: 'rule' | CommandKind
  status: CheckStatus
  required: boolean
  durationMs: number
  summary: string
  findings: Finding[]
  command?: string
  exitCode?: number | null
  timedOut?: boolean
  aborted?: boolean
  stdout?: string
  stderr?: string
  outputTruncated?: boolean
}

export interface DiffEvidence {
  path: string
  display: string
  kind: WorkspaceFileDiff['kind']
  text?: string
  addedLines: string[]
  truncated: boolean
}

export interface EvaluationReport {
  schemaVersion: 1
  runId: string
  sessionId: string
  turn: number
  eventSeq: number
  startedAt: string
  finishedAt: string
  durationMs: number
  verdict: EvaluationVerdict
  summary: WorkspaceChangesSummary
  checks: CheckResult[]
  diffEvidence: DiffEvidence[]
  artifactPath?: string
}

export interface EvaluationRequest {
  sessionId: SessionId
  eventSeq: number
  signal?: AbortSignal
}

export interface CommandExecutionResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  outputTruncated: boolean
}

export interface EvaluationDependencies {
  summary(sessionId: SessionId, eventSeq: number): WorkspaceChangesSummary | undefined
  diff(sessionId: SessionId, eventSeq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
  runCommand(command: CommandConfig, cwd: string, signal: AbortSignal): Promise<CommandExecutionResult>
  now?: () => number
  makeRunId?: () => string
}

export interface AgentEvaluator {
  evaluate(request: EvaluationRequest): Promise<EvaluationReport>
  latest(sessionId: SessionId): EvaluationReport | undefined
}
