import { isAbsolute } from 'node:path'
import type { Config, RuleConfig } from './types.js'

const RULE_KINDS_WITH_PATHS = new Set<RuleConfig['kind']>(['forbidden-path', 'required-path'])
const RULE_KINDS_WITH_PATTERN = new Set<RuleConfig['kind']>(['forbidden-pattern', 'required-pattern'])
const RULE_KINDS_WITH_LIMIT = new Set<RuleConfig['kind']>(['max-changed-files', 'max-diff-lines'])

export function validateConfig(config: Config): void {
  for (const [field, value] of [['maxDiffChars', config.maxDiffChars], ['maxOutputChars', config.maxOutputChars]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`agent-evaluator requires a positive integer ${field}`)
  }
  if (config.reportDir.trim() === '' || isAbsolute(config.reportDir) || config.reportDir.replaceAll('\\', '/').split('/').includes('..')) {
    throw new Error('agent-evaluator reportDir must be a non-empty relative path inside the workspace')
  }

  const ids = new Set<string>()
  for (const rule of config.rules) {
    validateId(ids, rule.id, 'rule')
    if (RULE_KINDS_WITH_PATHS.has(rule.kind) && (rule.paths === undefined || rule.paths.length === 0)) {
      throw new Error(`agent-evaluator rule '${rule.id}' requires non-empty paths`)
    }
    if (RULE_KINDS_WITH_PATTERN.has(rule.kind)) {
      if (rule.pattern === undefined || rule.pattern === '') throw new Error(`agent-evaluator rule '${rule.id}' requires pattern`)
      try {
        void new RegExp(rule.pattern, rule.flags ?? 'u')
      } catch (error: unknown) {
        throw new Error(`agent-evaluator rule '${rule.id}' has an invalid regular expression: ${String(error)}`)
      }
    }
    if (RULE_KINDS_WITH_LIMIT.has(rule.kind) && (!Number.isSafeInteger(rule.limit) || (rule.limit as number) < 0)) {
      throw new Error(`agent-evaluator rule '${rule.id}' requires a non-negative integer limit`)
    }
  }

  for (const command of config.commands) {
    validateId(ids, command.id, 'command')
    if (command.command.trim() === '') throw new Error(`agent-evaluator command '${command.id}' must not be empty`)
    if (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1)) {
      throw new Error(`agent-evaluator command '${command.id}' requires a positive integer timeoutMs`)
    }
  }
}
function validateId(ids: Set<string>, id: string, kind: string): void {
  if (id.trim() === '') throw new Error(`agent-evaluator ${kind} id must not be empty`)
  if (ids.has(id)) throw new Error(`agent-evaluator has duplicate check id '${id}'`)
  ids.add(id)
}
