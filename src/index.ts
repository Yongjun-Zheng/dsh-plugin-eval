import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { validateConfig } from './config.js'
import { createEvaluator } from './evaluator.js'
import { PendingJobs } from './pending-jobs.js'
import { persistReport } from './report.js'
import type {
  AgentEvaluator, CommandConfig, Config as PluginConfig, EvaluationReport, EvaluationRequest, RuleConfig,
} from './types.js'

export type {
  AgentEvaluator, CheckResult, CheckStatus, CommandConfig, CommandKind, DiffEvidence, EvaluationReport,
  EvaluationRequest, EvaluationVerdict, Finding, RuleConfig, RuleKind, RuleSeverity,
} from './types.js'
export type Config = PluginConfig
export { evaluateTurn } from './evaluator.js'
export { evaluateRule, globToRegExp } from './rules.js'

export const name = 'agent-evaluator'
export const inject = ['agents', 'shell', 'workspaceChanges']

const ruleSchema = z.object({
  id: z.string().required(),
  kind: z.union(['forbidden-path', 'required-path', 'forbidden-pattern', 'required-pattern', 'max-changed-files', 'max-diff-lines']).required(),
  paths: z.array(z.string()),
  pattern: z.string(),
  flags: z.string(),
  limit: z.number().step(1).min(0),
  severity: z.union(['error', 'warning']).default('error'),
}) as z<RuleConfig>

const commandSchema = z.object({
  id: z.string().required(),
  kind: z.union(['static', 'unit', 'e2e']).required(),
  command: z.string().required(),
  timeoutMs: z.number().step(1).min(1).default(120_000),
  required: z.boolean().default(true),
}) as z<CommandConfig>

export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean().default(true),
  runWhenNoChanges: z.boolean().default(false),
  reportDir: z.string().default('.dsh-eval/results'),
  maxDiffChars: z.number().step(1).min(1).default(200_000),
  maxOutputChars: z.number().step(1).min(1).default(20_000),
  rules: z.array(ruleSchema).default([]),
  commands: z.array(commandSchema).default([]),
}) as z<PluginConfig>

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentEvaluator: AgentEvaluator
  }

  interface Events {
    'agent-eval/completed'(report: EvaluationReport): void
  }
}

interface PendingJob {
  eventSeq: number
  turn: number
}

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(value.length - limit), truncated: true }
}

function activeWorkError(error: unknown): boolean {
  return error instanceof Error && /active work|already has active/u.test(error.message)
}

function whenIdleOrAborted(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return agent.whenIdle()
    }).then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

async function runWhenIdle<T>(agent: Agent, lifetime: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await whenIdleOrAborted(agent, lifetime)
    lifetime.throwIfAborted()
    let entered = false
    try {
      return await agent.runMaintenance(signal => {
        entered = true
        return task(AbortSignal.any([lifetime, signal]))
      })
    } catch (error: unknown) {
      if (entered || !activeWorkError(error) || attempt === 2) throw error
    }
  }
  throw new Error('Unable to enter Agent maintenance phase')
}

export function apply(ctx: Context, config: PluginConfig): void {
  validateConfig(config)
  const lifetime = new AbortController()
  const pending = new PendingJobs<Session, PendingJob>()
  const draining = new Map<Session, { controller: AbortController; task: Promise<void> }>()
  const evaluations = new Map<Promise<EvaluationReport>, { sessionId: SessionId; controller: AbortController }>()

  const evaluator = createEvaluator(config, {
    summary: (sessionId, eventSeq) => ctx.workspaceChanges.summary(sessionId, eventSeq),
    diff: (sessionId, eventSeq, index, signal) => ctx.workspaceChanges.diff(sessionId, eventSeq, index, signal),
    runCommand: async (command, cwd, signal) => {
      const execution = await ctx.shell.execute(ctx.shell.resolve({
        command: command.command,
        workdir: cwd,
        timeoutMs: command.timeoutMs ?? 120_000,
        stdoutMaxBytes: config.maxOutputChars * 4,
        signal,
      }))
      const result = await execution.result()
      const stdout = truncate(result.stdout.text, config.maxOutputChars)
      const stderr = truncate(result.stderr.text, config.maxOutputChars)
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdout: stdout.text,
        stderr: stderr.text,
        outputTruncated: stdout.truncated || stderr.truncated || result.stdout.truncated || result.stderr.truncated,
      }
    },
  })

  const service: AgentEvaluator = {
    evaluate: (request: EvaluationRequest) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(request.signal === undefined ? [] : [request.signal])])
      const task = (async () => {
        signal.throwIfAborted()
        const report = await evaluator.evaluate({ ...request, signal })
        signal.throwIfAborted()
        const persisted = await persistReport(config.reportDir, report)
        signal.throwIfAborted()
        evaluator.remember(persisted)
        return persisted
      })()
      evaluations.set(task, { sessionId: request.sessionId, controller })
      void task.then(() => { evaluations.delete(task) }, () => { evaluations.delete(task) })
      return task
    },
    latest: (sessionId: SessionId) => evaluator.latest(sessionId),
  }
  ctx.provide('agentEvaluator', service)

  ctx.effect(() => async () => {
    lifetime.abort()
    pending.clear()
    await Promise.allSettled([...Array.from(draining.values(), state => state.task), ...evaluations.keys()])
    evaluator.clear()
  })

  ctx.on('session/disposed', (session) => {
    pending.delete(session)
    draining.get(session)?.controller.abort()
    for (const evaluation of evaluations.values()) {
      if (evaluation.sessionId === session.id) evaluation.controller.abort()
    }
    evaluator.forget(session.id)
  })

  if (!config.enabled) {
    ctx.logger.info('agent-evaluator: disabled by configuration')
    return
  }

  const drain = (session: Session): void => {
    if (draining.has(session)) return
    const sessionId = session.id
    const controller = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    const task = Promise.resolve().then(async () => {
      while (!signal.aborted) {
        const job = pending.dequeue(session)
        if (job === undefined) break
        try {
          const agent = ctx.agents.get(sessionId)
          if (agent === undefined || agent.session !== session) {
            ctx.logger.warn(`agent-evaluator: live Agent not found for Session '${sessionId}'`)
            continue
          }
          const report = await runWhenIdle(agent, signal, signal => service.evaluate({
            sessionId,
            eventSeq: job.eventSeq,
            signal,
          }))
          signal.throwIfAborted()
          const passed = report.checks.filter(check => check.status === 'passed').length
          ctx.logger.info(`agent-evaluator: Session '${sessionId}' turn ${job.turn} ${report.verdict} (${passed}/${report.checks.length} checks); report: ${report.artifactPath ?? '(memory)'}`)
          ctx.emit('agent-eval/completed', report)
        } catch (error: unknown) {
          if (!signal.aborted) ctx.logger.error(`agent-evaluator: Session '${sessionId}' turn ${job.turn} failed: ${String(error)}`)
        }
      }
    }).finally(() => {
      draining.delete(session)
      if (pending.has(session) && !signal.aborted) drain(session)
    })
    draining.set(session, { controller, task })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'workspace/changes') return
    if (lifetime.signal.aborted) return
    pending.enqueue(session, { eventSeq: event.seq, turn: event.data.turn })
    drain(session)
  })
}

export default { name, inject, Config, apply }
