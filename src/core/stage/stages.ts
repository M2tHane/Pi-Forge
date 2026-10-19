// 流程与阶段控制：build 流程从架构阶段 S0 开始，批准 S0 后按计划追加批次阶段 S1…Sn。
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import type { FlowFile, TaskFile } from '../state/schemas.ts';
import { isSettled } from '../state/state-machine.ts';
import { git, gitOk } from '../state/git.ts';
import { ensureIntegrationBranch } from '../workspace/worktree.ts';
import { mergeToMain, publishSkeleton } from './release.ts';
import { approvablePlan, materializePlan, isArchitectStage } from '../plan/plan-flow.ts';
import { deliveryReport } from './signoff.ts';
import { acceptedHead, sameWork } from './stage-acceptance.ts';

export interface StageDeps { root: string; store: StateStore; config: FlowConfig }

export async function startFlow(d: StageDeps, description: string): Promise<FlowFile> {
  const main = d.config.raw.main_branch;
  if (!gitOk(d.root, ['show-ref', '--verify', '--quiet', `refs/heads/${main}`])) throw new Error(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  const base = git(d.root, ['rev-parse', main]).trim();
  const flow = await d.store.createFlow({ mode: 'build', title: description, stages: ['S0'], base_sha: base, actor: 'human' });
  ensureIntegrationBranch(d.root, flow.integration_branch, base);
  return flow;
}

/**
 * 批准 S0：先只校验计划；架构产出通常已由 S0 的门禁合入主分支，没有合入时（门禁没通过、经 /forge accept 放行）这里补合入，
 * 最后在一个事务里落地计划并批准；合入失败时状态不变，打回后照常派架构师返工，再批准时按新计划生成。
 * 最后阶段同样先合入再批准。
 */
export async function approveStage(d: StageDeps, flowId: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (flow.stage_status !== 'awaiting_human') throw new Error(notWaiting(flow, '批准'));
  assertStageSettled(d.store, flow);
  assertNothingSinceAcceptance(d, flow);
  const lines: string[] = [];
  if (isArchitectStage(flow.stage)) {
    approvablePlan(d.root, flow.integration_branch);
    const sha = await publishSkeleton(d.root, d.store, d.config, flowId);
    lines.push(`架构产出在 ${d.config.raw.main_branch} 上（${sha.slice(0, 8)}），之后的阶段在集成分支 ${flow.integration_branch} 上从这里继续。`);
    lines.push(...await materializePlan(d.root, d.store, d.config, flowId));
    lines.push(`已批准阶段 ${flow.stage}。`, `进入阶段 ${d.store.readFlow(flowId).stage}。`);
    return lines.join('\n');
  }
  if (flow.stage === flow.stages.at(-1)) {
    // 先把交付汇报存为阶段证据（失败不阻止合入），再合入
    try {
      await d.store.saveStageEvidence(flowId, flow.stage, 'delivery.md', deliveryReport(d.root, d.store, d.config, flowId), 'delivery');
      lines.push(`交付汇报已保存为阶段证据（delivery.md）；随时可用 /forge report 查看。`);
    } catch (e) {
      lines.push(`提示：交付汇报未能保存（${(e as Error).message.split('\n')[0]}），不影响合入。`);
    }
    // 上次已经合入、之后批准或推进阶段时失败：重试时集成分支已包含在主分支中，跳过合入直接批准
    if (gitOk(d.root, ['merge-base', '--is-ancestor', flow.integration_branch, d.config.raw.main_branch])) lines.push(`${flow.integration_branch} 已经包含在 ${d.config.raw.main_branch} 中，不再合入。`);
    else {
      const sha = await mergeToMain(d.root, d.store, d.config, flowId);
      lines.push(`已把 ${flow.integration_branch} 合入 ${d.config.raw.main_branch}（${sha.slice(0, 8)}）。`);
    }
  }
  const next = await d.store.finishStage(flowId, { to: 'done', trigger: 'approve', actor: 'human' });
  lines.push(`已批准阶段 ${flow.stage}。`, next.stage !== flow.stage ? `进入阶段 ${next.stage}。` : `流程 ${flow.id} 已完成。`);
  return lines.join('\n');
}

/**
 * 当前阶段没结束的任务（含咨询、修复）。等签收时还有这些任务就不能批准：阶段推进后没派出去的永远派不出去，
 * 在跑的改动要到批准之后才合入，绕过这一批的验收（最后一批时进不了主分支）。
 */
export function openStageTasks(store: StateStore, flow: Pick<FlowFile, 'id' | 'stage'>): TaskFile[] {
  return store.listTasks(flow.id).filter((t) => t.stage === flow.stage && !isSettled(t));
}

/** 本阶段还有没结束的任务时拒绝批准并列出它们；/forge-approve 在请用户确认合入之前也先查这个 */
export function assertStageSettled(store: StateStore, flow: Pick<FlowFile, 'id' | 'stage'>): void {
  const open = openStageTasks(store, flow);
  if (open.length) throw new Error(`阶段 ${flow.stage} 还有 ${open.length} 个任务没结束，完成后再批准：\n${open.map((t) => `- ${t.id}（${t.kind}，${t.status}）${t.title}`).join('\n')}`);
}

/**
 * 验收之后集成分支的代码又变了（刚合入、程序还没来得及退回重新验收）：不能批准，否则没验收过的改动进入下一批或主分支。
 * 上次批准已经合入主分支、之后失败重试时不查（合入本身会移动集成分支）。
 */
function assertNothingSinceAcceptance(d: StageDeps, flow: FlowFile): void {
  if (gitOk(d.root, ['merge-base', '--is-ancestor', flow.integration_branch, d.config.raw.main_branch])) return;
  const accepted = acceptedHead(d.store.readEvents(), flow.id, flow.stage);
  if (accepted && !sameWork(d.root, accepted, git(d.root, ['rev-parse', flow.integration_branch]).trim())) {
    throw new Error(`阶段 ${flow.stage} 验收之后集成分支的代码又有了改动，程序会重新验收，通过后再签收（/forge-status 查看进度）。`);
  }
}

const STATUS_TEXT: Record<string, string> = { active: '还在进行中', awaiting_gate: '正在跑阶段检查', needs_human: '门禁没通过、需要你处理', done: '已通过', aborted: '已中止' };
/** 不能批准或打回时的报错：写明阶段现在的状态和下一步 */
function notWaiting(flow: Pick<FlowFile, 'stage' | 'stage_status'>, action: '批准' | '打回'): string {
  const next = flow.stage_status === 'needs_human'
    ? `用 /forge accept ${flow.stage} --note "<说明>" 人工放行，或 /forge gate 重跑门禁、/forge-reject "<意见>" 打回`
    : '等它到了等你签收时再来；/forge-status 查看进度';
  return `阶段 ${flow.stage} 现在${STATUS_TEXT[flow.stage_status] ?? `是 ${flow.stage_status}`}，还不能${action}。${next}。`;
}

export async function rejectStage(d: StageDeps, flowId: string, feedback: string): Promise<string> {
  const flow = d.store.readFlow(flowId);
  if (!['awaiting_human', 'needs_human'].includes(flow.stage_status)) throw new Error(notWaiting(flow, '打回'));
  if (!feedback.trim()) throw new Error('打回必须写明意见：/forge-reject "<意见>"');
  const req = { to: 'active', trigger: 'reject', actor: 'human', reason: feedback } as const;
  if (isArchitectStage(flow.stage)) {
    await d.store.rejectForRework(flowId, req, `用户打回：${feedback}`);
    return `已打回架构阶段，程序将派 architect 返工（能接着原会话时接着，会话太大时开新会话；任务说明里带历次打回的意见）。`;
  }
  await d.store.transitionStage(flowId, req);
  return `已打回阶段 ${flow.stage}，意见已交给主会话：它判断要改的内容属于哪个任务，交程序建修复任务或交架构师；修改合入后重新验收（在那之前程序不会重新提交门禁）。`;
}

export interface ApprovalTarget { object: string; summary: string }
/** 等待用户批准（或处理）的对象：当前阶段的闸门 */
export function approvalTargets(store: StateStore, flowId: string): ApprovalTarget[] {
  const f = store.readFlow(flowId);
  return f.stage_status === 'awaiting_human' ? [{ object: `stage:${f.stage}`, summary: `stage:${f.stage} 等待用户批准` }] : [];
}

export async function unblockTask(d: StageDeps, flowId: string, taskId: string, answer?: string, reset = false): Promise<string> {
  const t = d.store.readTask(flowId, taskId);
  if (t.status !== 'blocked') throw new Error(`任务 ${taskId} 当前是 ${t.status}，不是 blocked。`);
  if (answer?.trim()) await d.store.appendHandoff(flowId, taskId, `用户回答：\n${answer.trim()}`, 'human');
  const next = await d.store.transitionTask(flowId, taskId, { to: t.worktree || t.branch ? 'in_progress' : 'ready', trigger: 'unblock', actor: 'human', facts: { reset } });
  return `已解除 ${taskId} 的阻塞，任务回到 ${next.status}${reset ? '（对应计数清零）' : '（保留计数）'}。`;
}
