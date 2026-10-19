# pi-forge 代码结构

这份文档讲 pi-forge 自己的代码怎么组织：有哪些进程、源码怎么分层、状态放在哪、引擎每一轮做什么。怎么用看 [README.md](README.md)，概念与一个任务在代码里怎么走看 [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)，状态机的图看 [docs/flow.md](docs/flow.md)，用假想项目推演一遍流程看 [WALKTHROUGH.md](WALKTHROUGH.md)。设计原则与开发约定在 [CLAUDE.md](CLAUDE.md)，设计决定与原因在 [NOTES.md](NOTES.md)。

（注意：生成的项目里也有一个 `docs/ARCHITECTURE.md`，那是用户写的技术栈，和这份无关。）

## 1. 进程与职责

```
用户 ──斜杠命令──▶ Pi 主会话（orchestrator 角色）
                    │  src/pi-adapter/extension.ts：注册 /forge-* 命令、forge_* 工具，每轮注入状态，拦截工具调用
                    ▼
                  引擎（src/core/engine/dispatcher.ts，在主会话进程里）
                    │  调度、派发、合并队列、门禁、审查与验收的编排；只经 state-store 写 .forge/
                    ▼
                  子进程：pi --mode rpc（每个 run 一个；src/pi-adapter/launcher.ts 启动）
                       src/pi-adapter/subagent.ts 最后加载：注册本角色的 forge_* 工具、guard 拦截所有工具调用
                       architect / backend / frontend / reviewer / stage-qa / worker 在各自的 worktree 里工作
```

- **调度不经过 LLM。** 选哪个任务、派给谁、并行几个、何时合并、何时跑门禁，全由引擎决定。主会话只汇报、提醒用户、处理程序交上来的判断（`forge_decide`）。
- **agent 只能申请。** 子进程里的 `forge_*` 工具是程序代码：校验 run 令牌（只在环境变量里，模型看不到）后经 state-store 写状态。模型能做的只是调用它们。
- **同一项目只有一个引擎。** 引擎锁在 `<项目>.worktrees/.engine.lock`（`ops/engine-lock.ts`）。
- **只有 `src/pi-adapter/` 调 Pi API。** 用到的 Pi 类型声明在 `src/pi-adapter/pi-api.d.ts`，核实过的版本记在 NOTES。

## 2. 源码分层

`src/core/` 是不依赖 Pi 的业务逻辑，下层不得 import 上层（`test/unit/core-layers.test.ts` 检查，新目录先在那里登记层号）：

| 层 | 目录 | 内容（主要文件） |
|---|---|---|
| 1 | `state/` | `.forge/` 的唯一读写入口 `state-store.ts`（事务、锁、事务日志重放）；转移表 `state-machine.ts`；`schemas.ts`（生成 `schemas/*.json`）；`event-log.ts`（事件哈希链、提交到 `refs/pi-forge/state`）；`config.ts`（workflow.yaml）、`project-commands.ts`（commands.yaml）；`git.ts`、`paths.ts`、`migrations.ts` |
| 2 | `security/` | `guard.ts`（禁止列表、只读角色的允许列表、受保护路径）、`shell.ts`（把 bash 命令拆成简单命令）、`redact.ts` |
| 2 | `workspace/` | `worktree.ts`（任务分支与 worktree）、`resources.ts`（端口段、每次运行的库）、`shared-env.ts`（共享依赖环境）、`workspace.ts`（依赖准备）、`verify-runner.ts`（跑命令）、`services.ts`、`forge-read.ts` |
| 3 | `verify/` | 同一棵代码树上通过过的命令沿用结果（`verify-cache.ts`） |
| 3 | `insight/` | 成本、预算、各角色的模型设置、停滞检测 |
| 4 | `spec/` | `prd.ts`（解析 REQ、AC、页面表并检查）、`intake.ts`（PRD 与原型入库）、`preflight.ts`（开流程前的检查） |
| 5 | `acceptance/` | 覆盖率（扫测试名里的 `REQ-xxx.ACn`）、阶段问题的归属与修复任务 |
| 6 | `plan/` | `plan-flow.ts`（S0 提交检查、批准时落地计划）、`batches.ts`（解析 `docs/plan.md` 的 yaml、生成批次任务）、只追加的自动合并、契约的结构化合并、小改动的迷你计划 |
| 7 | `stage/` | `stages.ts`（开始流程、批准、打回）、`gates.ts`（门禁；S0 的门禁是合入主分支加 install、env_up）、`review*.ts`（审查轮次、材料、要跑的测试）、`stage-acceptance.ts` 与 `stage-qa.ts`（批次验收）、`release.ts`（合入主分支）、`signoff.ts`（签收材料、交付汇报） |
| 8 | `engine/` | `dispatcher.ts`（引擎）、`merge-queue.ts`、`post-merge-test.ts`（合并后回归）、`consult.ts`（架构师问答）、`decisions.ts`（交给主会话的判断）、`prompt-assembler.ts`、`subagent-runtime.ts`、`scheduler.ts`、`knowledge.ts`、`model-pause.ts` |
| 9 | `ops/` | 斜杠命令背后的运维与查看：`init.ts`、`doctor.ts`、`resume.ts`、`status-view.ts` |

`src/core/` 之外：

| 目录 | 内容 |
|---|---|
| `src/tools/` | `forge_*` 工具的实现：`subagent-tools.ts`（claim、note、submit、block…）、`orchestrator-tools.ts`（status、wait、decide、ask_architect…）、`module-tools.ts`（forge_sync） |
| `src/commands/` | 斜杠命令：`forge.ts`（/forge-* 与 /forge 子命令）、`forge-config.ts` |
| `src/modes/` | 轻流程：`fix.ts`（/forge-fix）、`change.ts`（/forge-change），都是单阶段 X1，直接合入主分支 |
| `src/pi-adapter/` | Pi 扩展入口 `extension.ts`、子进程扩展 `subagent.ts`、`launcher.ts`（rpc 模式起子进程） |
| `agents/`、`rules/`、`skills/` | 角色提示、规则、技能：进子进程的系统提示（改了会让提示缓存失效一次，记在 NOTES 的"缓存提醒"） |
| `templates/` | `/forge-init` 生成的项目文件与示例 |
| `scripts/` | 测试分组、schema 生成、事件查看器、真实模型实验的驱动（`real-build.ts`） |

## 3. 状态：`.forge/`

在生成的项目根目录，不进任何分支；事务写入后提交到专用引用 `refs/pi-forge/state`。

| 路径 | 内容 |
|---|---|
| `state.json` | 当前流程等全局状态 |
| `flows/<流程>/flow.json` | 流程：阶段列表、当前阶段与状态、集成分支、批次（`s_stages`）、门禁轮次 |
| `flows/<流程>/tasks/<任务>.json` | 任务：类型、角色、状态、依赖、可写范围、worktree、租约 |
| `flows/<流程>/handoff/<任务>.md` | 任务说明与交接记录（用户回答、审查意见都追加在这里） |
| `flows/<流程>/evidence/<任务或阶段>/` | 证据：审查输入、门禁日志、覆盖率、交付汇报 |
| `flows/<流程>/notes/<任务>.json` | 任务的结构化笔记 |
| `events.jsonl` | 只追加的事件日志，带哈希链 |
| `runs/<run>.json` | 每次子进程运行：角色、模型、token、费用、结果 |
| `merge-queue.json`、`knowledge.json`、`model-pauses.json`、`notes/main.json` | 合并队列、项目知识、被暂停的模型、主会话笔记 |
| `tx.json` | 事务日志：中断时重放 |

写入规则：只经 `state-store.ts` 的事务写；状态变化只走 `state-machine.ts` 的转移表（`transitionTask`、`transitionStage`），其他字段用 `updateTask` 的白名单。

## 4. 状态机

- **阶段：** `active` → `awaiting_gate`（门禁与验收进行中）→ `awaiting_human`（等用户批准或签收）→ `done`；门禁或验收用尽、无法归属时 `needs_human`；用户可以 `abort`。S0 与最后一个阶段一律要人工。
- **任务：** `pending` → `ready` → `in_progress` → `in_review` → `queued_merge` → `merging` → `done`；另有 `blocked`、`cancelled`。
- **任务类型：** impl（实现）、review（`.rv`）、fix（`.fx-n`）、merge-fix、qa（`S1.qa`）、doc、consult（架构师咨询）。

图与每条转移的触发见 [docs/flow.md](docs/flow.md)。

## 5. 引擎每一轮（`dispatcher.pump`）

run 结束、合并完成、命令执行、定时器（门禁出错的重试）都会触发一轮，同一流程串行执行：

1. 阶段边界：本阶段还没同步过主分支时，把主分支上的新提交合进集成分支。
2. 处理审查结论（`resolveReviews`）、架构师的回答（`resolveConsults`）。
3. `promote`：硬依赖都完成的 `pending` 任务转 `ready`。
4. 被打回、没有租约的 `in_progress` 任务重新派发（接着原会话）；由程序直接派发的任务（审查、merge-fix、咨询、S0 的任务）派发。
5. `advanceStage`：S0 没有进行中的架构任务时建一个；本阶段的工作都结束时跑门禁（S0：合入主分支、主工作区 install 与 env_up；批次：全量命令、覆盖率），再编排 stage-qa、修复与签收。
6. 自动派发 `ready` 任务（`scheduler.ts` 按关键路径、并发上限挑）。

派发一个任务：建或复用 worktree → 准备依赖（链接共享环境或各自 install）→ 分配端口段与数据库（`db_create`）→ 组提示 → 启动子进程，带租约与超时。提交后：审查 → 合并队列（压成一个提交、rebase、冲突标记检查、快进集成分支）→ 后台合并后回归。

## 6. git 与目录

| 位置 | 内容 |
|---|---|
| `main` | 用户的分支；S0 审查通过后的架构产出、交付时的全部代码 |
| `flow/<流程>/integration` | 集成分支：所有任务合入这里；S0 门禁时与交付时 `--no-ff` 合入 main |
| `flow/<流程>/<任务>` | 任务分支：从集成分支开出，合入后删除 |
| `<项目>.worktrees/<流程>-<任务>/` | 任务的 worktree（审查者用被审查任务的那一个，只读） |
| `<项目>.worktrees/.env-shared/` | 共享依赖环境（S1 开始时建，worktree 链接依赖目录） |
| `<项目>.worktrees/.resources.json`、`.tmp/`、`.scratch/` | 每次运行的端口段与库的登记、临时目录 |

数据库等服务只有一份：`env_up` 在主工作区执行（S0 门禁、建共享环境时），所有分支与每次运行共用；每次运行用 `db_create` 建自己的库，结束时 `db_drop`。

## 7. 子进程的提示与权限

- **提示**（`prompt-assembler.ts`）：稳定内容进系统提示（角色提示 `agents/<角色>.md`、`rules/`、技能、项目知识），动态内容进用户消息（任务说明、上游与本任务的 handoff、上次没通过的原因）。顺序固定以命中提示缓存。
- **权限**（`guard.ts`，由 `subagent-runtime.ts` 在每次工具调用前检查）：实施角色只拦禁止列表（`.forge/`、`.git/`、`workflow.yaml`、密钥、项目外路径、PRD 与原型；后端与前端还有契约与架构文档）；只读的 reviewer 按允许列表：只读命令，加上项目的测试与检查命令（`test`、`acceptance`、`typecheck`、`lint`、`arch_check`、`contract_check`）。
- **工具**：每个角色启用的工具在 `workflow.yaml` 的 `roles` 与 `tool_groups`。

## 8. 测试与实验

- 单元测试 `test/unit/`：`npm run test:fast`（纯函数）、`test:slow`（用到 git）。
- e2e `test/e2e/`：`test/fixtures/fake-subagent` 用脚本代替模型调用工具，仍经过真实的 guard 与 `forge_*` 工具；`test/fixtures/fake-llm` 是给真实 pi 进程用的假模型服务。
- 真实模型实验：`scripts/real-build.ts` 加 `scripts/real-build-suites/<套件>/`（PRD、技术栈、原型、隐藏测试），花钱，只在明确要求时跑；结论写进 NOTES 的"真实模型实验"。
