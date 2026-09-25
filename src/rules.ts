import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import type { CheckResult, DiffEvidence, Finding, RuleConfig } from './types.js'

function escapeRegexChar(char: string): string {
  return /[\\^$.[\]|()+{}]/u.test(char) ? `\\${char}` : char
}
/** Compile the small, documented glob subset used by path rules. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll('\\', '/')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegexChar(char)
    }
  }
  return new RegExp(`${source}$`, 'u')
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function result(rule: RuleConfig, status: CheckResult['status'], summary: string, findings: Finding[] = []): CheckResult {
  return {
    id: rule.id,
    kind: 'rule',
    status,
    required: (rule.severity ?? 'error') === 'error',
    durationMs: 0,
    summary,
    findings,
  }
}

function validateCompleteness(rule: RuleConfig, summary: WorkspaceChangesSummary, evidence: readonly DiffEvidence[]): CheckResult | undefined {
  if (summary.total > summary.files.length) {
    return result(rule, 'error', 'Workspace change list was capped; the rule cannot inspect every changed file.', [{
      code: 'incomplete-file-list',
      message: `Only ${summary.files.length} of ${summary.total} changed files are available.`,
    }])
  }
  if ((rule.kind === 'forbidden-pattern' || rule.kind === 'required-pattern') && evidence.some(item => item.truncated || item.kind !== 'text')) {
    return result(rule, 'error', 'Diff evidence was incomplete; the content rule failed closed.', [{
      code: 'incomplete-diff',
      message: 'At least one changed file was binary, oversized, unavailable, or truncated.',
    }])
  }
  return undefined
}

function pathRule(rule: RuleConfig, summary: WorkspaceChangesSummary, forbidden: boolean): CheckResult {
  const patterns = (rule.paths ?? []).map(globToRegExp)
  const matches = summary.files.filter(file => patterns.some(pattern => pattern.test(normalizedPath(file.path))))
  const failed = forbidden ? matches.length > 0 : matches.length === 0
  if (!failed) return result(rule, 'passed', forbidden ? 'No forbidden paths changed.' : 'A required path changed.')
  const findings: Finding[] = forbidden
    ? matches.map(file => ({ code: 'forbidden-path', path: file.path, message: `Changed path '${file.display}' is forbidden.` }))
    : [{ code: 'required-path', message: `No changed path matched: ${(rule.paths ?? []).join(', ')}` }]
  return result(rule, 'failed', forbidden ? `${matches.length} forbidden path(s) changed.` : 'No required path changed.', findings)
}

function patternRule(rule: RuleConfig, evidence: readonly DiffEvidence[], forbidden: boolean): CheckResult {
  const expression = new RegExp(rule.pattern as string, rule.flags ?? 'u')
  const findings: Finding[] = []
  for (const file of evidence) {
    for (let index = 0; index < file.addedLines.length; index += 1) {
      expression.lastIndex = 0
      if (expression.test(file.addedLines[index] as string)) {
        findings.push({
          code: forbidden ? 'forbidden-pattern' : 'required-pattern',
          path: file.path,
          line: index + 1,
          message: `Added line matched /${rule.pattern}/${rule.flags ?? 'u'}.`,
        })
      }
    }
  }
  const failed = forbidden ? findings.length > 0 : findings.length === 0
  if (!failed) return result(rule, 'passed', forbidden ? 'No forbidden added code matched.' : 'Required added code matched.')
  return result(
    rule,
    'failed',
    forbidden ? `${findings.length} forbidden added line(s) matched.` : 'No added line matched the required pattern.',
    forbidden ? findings : [{ code: 'required-pattern', message: `No added line matched /${rule.pattern}/${rule.flags ?? 'u'}.` }],
  )
}

export function evaluateRule(
  rule: RuleConfig,
  summary: WorkspaceChangesSummary,
  evidence: readonly DiffEvidence[],
): CheckResult {
  const incomplete = validateCompleteness(rule, summary, evidence)
  if (incomplete !== undefined) return incomplete

  switch (rule.kind) {
    case 'forbidden-path': return pathRule(rule, summary, true)
    case 'required-path': return pathRule(rule, summary, false)
    case 'forbidden-pattern': return patternRule(rule, evidence, true)
    case 'required-pattern': return patternRule(rule, evidence, false)
    case 'max-changed-files': {
      const failed = summary.total > (rule.limit as number)
      return result(rule, failed ? 'failed' : 'passed', `${summary.total} changed file(s); limit is ${rule.limit}.`, failed
        ? [{ code: 'max-changed-files', message: `${summary.total} exceeds ${rule.limit}.` }]
        : [])
    }
    case 'max-diff-lines': {
      const lines = summary.added + summary.deleted
      const failed = lines > (rule.limit as number)
      return result(rule, failed ? 'failed' : 'passed', `${lines} changed line(s); limit is ${rule.limit}.`, failed
        ? [{ code: 'max-diff-lines', message: `${lines} exceeds ${rule.limit}.` }]
        : [])
    }
  }
}
