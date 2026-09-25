# dsh-plugin-eval

面向 Coding Agent 的 DeepSeek Harness 自动评测插件。

Agent 的顶层 turn 结束后，插件读取 DSH `workspaceChanges` 记录的精确变更，执行确定性规则和配置好的静态检查、单元测试或 E2E 命令，并将 JSON 报告写入工作区的 `.dsh-eval/results`。

当前支持：

- 基于 `workspace/changes` 的 turn 级触发，不把历史未提交修改误算到当前 turn。
- 每个 Session 串行执行，并在 Agent 进入 idle 后通过 maintenance 阶段评测。
- 路径、正则、文件数和 diff 行数规则。
- static、unit、e2e 三类命令检查。
- `passed`、`failed`、`error`、`skipped` 明确分离。
- 内存中的 `ctx.agentEvaluator` 服务和 `agent-eval/completed` Cordis 事件。
- 原子写入、可机器读取的 JSON 报告。

## 环境要求

- Node.js `^22.19.0 || >=24`
- DeepSeek Harness `0.1.7-rc.2`
- profile 中启用 `agents`、`shell` 和 `workspaceChanges` 服务

## 开发

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

仓库内的 `.dsh-dev/deepseek-harness` 是被 Git 忽略的官方 DSH 浅克隆，只用于本地 API 对照和集成测试。

## 安装到 DSH profile

先构建插件：

```powershell
pnpm build
```

然后从本仓库的上一级目录执行：

```powershell
dsh plugin --profile web add ./dsh-plugin-eval
```

包中的 `cordis.patch.yml` 会插入 `agent-evaluator` 插件行。

## 配置

用户可以在 profile 的 `cordis.patch.yml` 中覆盖插件行。DSH 的 patch 会整体替换 `config`，因此要写出需要保留的全部配置：

```yaml
- id: agent-evaluator
  name: dsh-plugin-eval
  config:
    enabled: true
    runWhenNoChanges: false
    reportDir: .dsh-eval/results
    maxDiffChars: 200000
    maxOutputChars: 20000

    rules:
      - id: protect-lockfile
        kind: forbidden-path
        paths:
          - pnpm-lock.yaml
        severity: error

      - id: no-debugger
        kind: forbidden-pattern
        pattern: "\\bdebugger\\b"
        flags: "u"
        severity: error

      - id: change-budget
        kind: max-diff-lines
        limit: 1000
        severity: warning

    commands:
      - id: typecheck
        kind: static
        command: pnpm typecheck
        timeoutMs: 120000
        required: true

      - id: unit
        kind: unit
        command: pnpm test
        timeoutMs: 300000
        required: true
```

### 规则类型

| 类型 | 字段 | 含义 |
| --- | --- | --- |
| `forbidden-path` | `paths` | 任一变更路径匹配 glob 时失败 |
| `required-path` | `paths` | 没有变更路径匹配 glob 时失败 |
| `forbidden-pattern` | `pattern`, `flags` | 新增代码行匹配正则时失败 |
| `required-pattern` | `pattern`, `flags` | 所有新增代码行均不匹配时失败 |
| `max-changed-files` | `limit` | 完整变更文件数超过限制时失败 |
| `max-diff-lines` | `limit` | 新增行与删除行之和超过限制时失败 |

Glob 支持 `*`、`**` 和 `?`，并统一使用 `/` 作为路径分隔符。

`severity: error` 是硬门禁；`severity: warning` 会保留 finding，但不会令总体评测失败。命令配置只能来自可信 profile，插件不会把模型输出或文件名拼接进命令。

## 报告

默认报告路径：

```text
<workspace>/.dsh-eval/results/<session-id>/turn-<turn>-<run-id>.json
```

总体结论规则：

1. 必需检查发生基础设施错误：`error`
2. 任一硬规则或必需命令失败：`failed`
3. 没有变更且未启用 `runWhenNoChanges`：`skipped`
4. 其他情况：`passed`

## 当前边界

- MVP 尚未加入 LLM Judge 和自动修复回路。
- 命令在 profile 提供的 `ctx.shell` 执行器中运行；是否沙箱化由 DSH composition 决定。
- 模式规则只检查 diff 的新增行，不扫描整个文件。
- `workspaceChanges` 因文件上限或 diff 字符上限无法提供完整证据时，相关内容规则会 fail closed 为 `error`。
