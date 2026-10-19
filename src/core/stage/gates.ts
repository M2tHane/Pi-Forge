// 阶段门禁（gate）：在集成分支 HEAD 上执行 auto 命令并保存 evidence，覆盖率只报告；S0 的门禁不跑测试，见 publishArchitecture。
// 通过后：需要人工 → awaiting_human；否则 → done。S0（用户验收）与最后一个阶段（批准时合入主分支）一律需要人工。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowEvent } from '../state/schemas.ts';
import { git } from '../state/git.ts';
import { failingFiles } from '../workspace/scope-hint.ts';
import { worktreesRoot, removeWorktree, runInMainWorkspace } from '../workspace/worktree.ts';
import { evidenceText, failureSummary, noteToolMissing, runShell } from '../workspace/verify-runner.ts';
import { prepareWorkspaceRecorded } from '../workspace/workspace.ts';
import { resourceOptions, withResources } from '../workspace/resources.ts';

import type { StageDeps } from './stages.ts';
import { isLightFlow, type TaskFile } from '../state/schemas.ts';
import { headSha } from '../workspace/worktree.ts';
import { recordVerified, reusableRuns, reuseText, treeOfCommit } from '../verify/verify-cache.ts';
import { failingAcceptanceDirs } from '../acceptance/acceptance-flow.ts';
import { planStageFixTasks, type StageIssue } from '../acceptance/stage-fix.ts';
import { createdSinceReopen } from './stage-rounds.ts';
import { publishSkeleton } from './release.ts';
import { isArchitectStage } from '../plan/plan-flow.ts';
import { stageCoverage, writeCoverageReport, type CoverageResult } from '../acceptance/coverage.ts';

/** failed：失败的闸门命令与输出；引擎据此生成有限轮次的修复任务。 */
export interface GateOutcome { stage: string; passed: boolean; needsHuman: boolean; reasons: string[]; failed?: { command: string; output: string } }

/** 没配置 implementation_gate.auto 时门禁跑的命令 */
export const DEFAULT_GATE_AUTO = ['test', 'acceptance', 'arch_check', 'contract_check'] as const;

/** 阶段门禁：各阶段共用 implementation_gate，auto 里 commands 没定义的命令跳过 */
export function stageDef(config: FlowConfig, stage: string) {
  const gate = config.raw.implementation_gate;
  return { id: stage, gate: {
    auto: (gate?.auto ?? [...DEFAULT_GATE_AUTO]).filter((name) => !!config.commands[name]?.trim()),
    human: gate?.human ?? true,
  } };
}

export interface ImplementationChecks {
  stage: string;
  passed: boolean;
  reasons: string[];
  failed?: { command: string; output: string };
  /** 命令都通过、gate.coverage 开启、且计划里有本阶段时才有 */
  coverage?: CoverageResult;
  /** 命令跑在的集成分支 HEAD。不取写完覆盖报告之后的 HEAD：运行期间合入的提交没跑过门禁，取了就会被当成已通过 */
  head: string;
}

/**
 * 实施阶段的程序检查：在集成分支 HEAD 的临时 worktree 里跑 auto 命令（带资源、保存 evidence），
 * 通过后计算覆盖率，把报告存成阶段 evidence（coverage.md）并提交到集成分支的 docs/qa/<stage>.md。覆盖率只报告（签收时给用户看），缺口不拦门禁。
 * 不迁移阶段状态：由调用方（主会话的编排）决定。命令失败时不算覆盖率。
 */
export async function runImplementationChecks(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<ImplementationChecks> {
  const flow = store.readFlow(flowId);
  if (isLightFlow(flow)) throw new Error('修复与小改动流程不使用阶段闸门');
  if (isArchitectStage(flow.stage)) return publishArchitecture(root, store, config, flowId, timeoutMs);
  const def = stageDef(config, flow.stage);
  const reasons: string[] = [];
  let failed: ImplementationChecks['failed'];
  const startHead = headSha(root, flow.integration_branch);

  // 同一棵代码树上、命令内容相同、已经通过的命令（通常是最后一次合并验证跑过的）沿用结果，并写沿用记录
  const tree = treeOfCommit(root, startHead);
  const full = (def.gate.auto ?? []).map((name) => ({ name, shell: config.commands[name]!.replace('{files}', '').trim() }));
  const reused = reusableRuns(store.readEvents(), flowId, tree, full);
  if (reused.size) await store.saveStageEvidence(flowId, flow.stage, 'gate-reused.txt', reuseText(tree!, reused), 'gate');
  const plan = full.filter((c) => !reused.has(c.name));
  if (plan.length) {
    const wt = path.join(worktreesRoot(root), `${flowId}-gate-${flow.stage}`);
    mkdirSync(path.dirname(wt), { recursive: true });
    removeWorktree(root, wt);
    git(root, ['worktree', 'add', '-q', '--detach', wt, startHead]);
    try {
      // F1：新 worktree 里没有依赖，先准备（readonly，走缓存）。失败不设 failed：不是某个 task 的问题，交给人
      const prep = await prepareWorkspaceRecorded(store, root, config, wt, 'readonly', { flow: flowId, actor: 'gate' }, timeoutMs);
      if (!prep.ok) reasons.push(`工作区准备失败：${prep.reason ?? ''}`);
      else await withResources(root, `gate-${flowId}-${flow.stage}`, { ...resourceOptions(config), cwd: wt }, async (env) => {
        const passed: { name: string; shell: string; evidence: string }[] = [];
        for (const { name, shell } of plan) {
          const r = { command: name, ...(await runShell(shell, wt, timeoutMs, env)) };
          const ev = await store.saveStageEvidence(flowId, flow.stage, `gate-${name}.log`, evidenceText(r, shell), 'gate');
          if (await noteToolMissing(store, r, { flow: flowId, stage: flow.stage, actor: 'gate' })) continue;
          if (r.exit_code === 0) passed.push({ name, shell, evidence: ev });
          if (r.exit_code !== 0) {
            reasons.push(`闸门命令 ${name} 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1200)}`);
            failed = { command: name, output: r.output };
            break;
          }
        }
        await recordVerified(store, flowId, tree, passed, { stage: flow.stage, actor: 'gate' });
      });
    } finally {
      removeWorktree(root, wt);
    }
  }

  let coverage: CoverageResult | undefined;
  if (!reasons.length && config.raw.implementation_gate?.coverage !== false && (flow.s_stages ?? []).some((s) => s.id === flow.stage)) {
    try {
      coverage = stageCoverage(root, store, config, flowId, flow.stage, startHead);
      await store.saveStageEvidence(flowId, flow.stage, 'coverage.md', coverage.markdown, 'gate');
      await writeCoverageReport(root, store, flowId, flow.stage, coverage.markdown);
    } catch (e) {
      reasons.push(`覆盖率无法计算：${(e as Error).message}`);
    }
  }
  return { stage: flow.stage, passed: reasons.length === 0, reasons, ...(failed ? { failed } : {}), ...(coverage ? { coverage } : {}), head: startHead };
}

/**
 * S0 的门禁：测试已由审查者在架构师的分支上跑过（全量 test 与 acceptance），这里把架构产出合入主分支（集成分支移到合入后的提交），
 * 再在主工作区执行 install 与 env_up（它们改了的已提交文件还原、新出现的写进本地 exclude，主工作区保持干净，下次还能合入），用户直接在主工作区验收。env_up 起的服务（数据库容器）之后所有分支与每次运行共用，各自用 db_create 建自己的库。
 * 用户打回、返工合入后再走一遍：再合入一次，install 与 env_up 再执行一次（env_up 要能重复执行）。
 */
async function publishArchitecture(root: string, store: StateStore, config: FlowConfig, flowId: string, timeoutMs?: number): Promise<ImplementationChecks> {
  const stage = store.readFlow(flowId).stage;
  const head = await publishSkeleton(root, store, config, flowId);
  for (const name of ['install', 'env_up'] as const) {
    const shell = config.commands[name]?.trim();
    if (!shell) continue;
    const { restored, ...run } = await runInMainWorkspace(root, shell, timeoutMs);
    const r = { command: name, ...run };
    await store.saveStageEvidence(flowId, stage, `gate-${name}.log`, evidenceText(r, shell), 'gate');
    if (restored.length) {
      await store.recordEvent({ flow: flowId, actor: 'gate', type: 'note', reason: `主工作区执行 ${name} 改了已提交的文件，已还原成提交的版本：${restored.slice(0, 10).join('、')}${restored.length > 10 ? ` 等 ${restored.length} 个` : ''}`, data: { restored } });
    }
    if (r.exit_code !== 0) {
      return { stage, passed: false, head, failed: { command: name, output: r.output },
        reasons: [`主工作区执行 ${name} 失败（退出码 ${r.exit_code}）：\n${failureSummary(r.output, 1200)}`] };
    }
  }
  return { stage, passed: true, reasons: [], head };
}

/**
 * 最近一次门禁失败或用户打回之后，本阶段还没有任何任务状态变化：返回那次事件，否则 null。
 * 用户打回也算：task 都已完成时引擎会立刻重新提交门禁，打回就白费了（stock 实验：打回 6 秒后又回到等签收，主会话来不及处理）。
 * 这时流程不会自己继续，只有 /forge gate 能让它重新验收（状态视图据此提示）。
 */
export function stopWithoutChange(store: StateStore, flowId: string, stage: string): FlowEvent | null {
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const last = [...events].reverse().find((e) => e.to === 'active' && e.data?.['stage'] === stage && (e.type === 'gate_result' || e.trigger === 'reject'));
  if (!last) return null;
  const stageTasks = new Set(store.listTasks(flowId).filter((t) => t.stage === stage).map((t) => t.id));
  return events.some((e) => e.seq > last.seq && e.type === 'transition' && e.task && stageTasks.has(e.task)) ? null : last;
}
export const gateFailedWithoutChange = (store: StateStore, flowId: string, stage: string): boolean => !!stopWithoutChange(store, flowId, stage);
// M6 由 stage-qa 取代：暂时保留 HEAD 的有限门禁修复。
export const MAX_GATE_ROUNDS = 2;
function safeGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ''; }
}

/**
 * 闸门命令失败的输出 → 问题（纯函数）：同一次失败只生成一条。
 * 日志里的 tests/acceptance/<T-xxx>/ 对应的 impl 作为候选负责者，和其他仓库文件的归属（stage-fix 的 ownerOf）一起判断。
 */
export function gateIssues(failed: { command: string; output: string }, tasks: readonly Pick<TaskFile, 'id' | 'kind'>[], tracked: ReadonlySet<string>): StageIssue[] {
  const tail = failed.output.trim().split('\n').slice(-60).join('\n').slice(-4000);
  const text = `实施阶段的全量 ${failed.command} 失败（程序生成）。\n命令：${failed.command}\n输出（最后部分）：\n\`\`\`\n${tail}\n\`\`\``;
  const candidates = failingAcceptanceDirs(failed.output).filter((dir) => tasks.some((t) => t.id === dir && t.kind === 'impl'));
  const files = failingFiles(failed.output, tracked).filter((f) => !f.startsWith('tests/acceptance/'));
  return candidates.length || files.length ? [{ files, text, ...(candidates.length ? { candidates } : {}) }] : [];
}

/**
 * 闸门的全量测试失败：问题按负责的 task 分组，为每个 task 建 .fx-n 修复任务，并记一轮 gate_rounds。
 * 返回生成的任务 id；已修 MAX_GATE_ROUNDS 轮或定位不到负责 task 时返回空数组并给出原因（由调用方提示用户）。
 */
export async function gateFailed(d: StageDeps, flowId: string, failed: { command: string; output: string }): Promise<{ tasks: string[]; reason?: string }> {
  const { store } = d;
  const flow = store.readFlow(flowId);
  // 轮数从本阶段最近一次重开（打回等）算起
  const since = createdSinceReopen(store.readEvents(), flowId, flow.stage);
  const rounds = (flow.gate_rounds ?? []).filter((r) => r.stage === flow.stage && (!since || r.tasks.some((t) => since.has(t))));
  if (rounds.length >= MAX_GATE_ROUNDS) return { tasks: [], reason: `全量 ${failed.command} 自动修复 ${MAX_GATE_ROUNDS} 轮后仍失败` };
  const tracked = new Set(safeGit(d.root, ['ls-tree', '-r', '--name-only', flow.integration_branch]).split('\n').filter(Boolean));
  const issues = gateIssues(failed, store.listTasks(flowId), tracked);
  const plan = issues.length ? planStageFixTasks(store, flowId, 'gate', issues, `第 ${rounds.length + 1} 轮`) : null;
  if (!plan?.inputs.length) return { tasks: [], reason: `全量 ${failed.command} 失败，但无法从日志定位负责的 task` };
  const tasks = plan.inputs.map((t) => t.id);
  // 修复任务与轮次记录在同一个事务里写：分开写时中途中断，重跑门禁会按同一次失败再建一组修复
  await store.addGateRound(flowId, { stage: flow.stage, command: failed.command, tasks, at: new Date().toISOString() }, plan.inputs, plan.briefs);
  return { tasks };
}
