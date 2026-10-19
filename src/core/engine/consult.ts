// 架构师咨询：子 agent 或主会话用 forge_ask_architect 提问 → 程序建 consult 任务（architect，不审查；派发规则见 heldConsults）
// → architect 接着它最近一次的会话回答，用 forge_answer 提交（有改动时经合并队列合入集成分支）
// → 子 agent 的任务：回答写进 handoff、集成分支同步进它的 worktree，接着原会话继续；主会话：下一次 forge_wait 返回回答。
import { existsSync, readFileSync } from 'node:fs';
import type { FlowConfig } from '../state/config.ts';
import type { TaskFile } from '../state/schemas.ts';
import { evidenceRel, type StateStore } from '../state/state-store.ts';
import { IN_FLIGHT, isSettled } from '../state/state-machine.ts';
import { DECISIONS_PATH, nextPlanTaskId } from '../state/paths.ts';
import { readRel, usedTaskIds } from '../plan/plan-flow.ts';
import { pendingConflicts, syncTaskInputs } from '../../tools/module-tools.ts';
import { gitOk } from '../state/git.ts';
import { removeWorktree } from '../workspace/worktree.ts';

export type AskKind = 'answer' | 'change';
export const ANSWER_FILE = 'answer.md';
/** 任务说明里带的 decisions.md 最多这么多字（取最近的部分） */
const DECISIONS_TAIL = 12_000;

const KIND_TEXT: Record<AskKind, string> = { answer: 'answer（只要回答）', change: 'change（要求修改公共内容或契约）' };

export function consultBrief(question: string, kind: AskKind, asker: Pick<TaskFile, 'id' | 'title' | 'role'> | null): string {
  return [
    '# 架构师咨询',
    `提问方：${asker ? `${asker.id}「${asker.title}」（${asker.role}）` : '主会话（转达用户的问题）'}`,
    `类型：${KIND_TEXT[kind]}`,
    '', '## 问题', question.trim(), '',
    '## 做法',
    '- 先读相关的代码与文档再回答，结论放在最前面。',
    `- ${kind === 'change' ? '需要修改公共代码、契约或文档时直接在本 worktree 里改，跑相关测试；改动随回答提交，经合并队列合入集成分支，程序再同步给提问方。' : '只需回答；发现确实要改公共内容才顺带修改（同样随回答提交）。'}`,
    `- 在 ${DECISIONS_PATH} 末尾追加一条记录：提问方、问题、结论、改了哪些文件。`,
    '- 最后用 forge_answer 提交给提问方的回答（写清楚结论、改了哪些文件、提问方接下来怎么做）。',
  ].join('\n');
}

/** 新建 consult 任务（写好任务说明）；子 agent 提问时调用方随后把它的任务转为"等架构师"（先建咨询，程序步骤不会看到等待却找不到咨询的任务） */
export async function createConsult(store: StateStore, config: FlowConfig, flowId: string, question: string, kind: AskKind, asker: TaskFile | null, actor: string): Promise<TaskFile> {
  const flow = store.readFlow(flowId);
  // 编号在事务里分配：两个 agent 同时提问时不会撞号；口径同计划任务（含此前各流程与主分支上的验收目录）。
  // 同一条消息里的两次提问会被 Pi 并行执行：提问方已有没结束的咨询时不再建，否则它等的是第一个，最近的却是撤回的第二个
  // 问题说明和任务在同一事务里写：分两次写时，中间引擎可能已派发它（架构师拿到空说明），或进程被杀后留下没有说明的咨询。
  // 编号在事务里才知道，所以在求值任务时把说明填进 handoffs（addTasks 先求值任务、再写 handoffs）
  const handoffs: Record<string, string> = {};
  const [task] = await store.addTasks(flowId, () => {
    const open = asker && store.listTasks(flowId).find((t) => t.kind === 'consult' && t.for_task === asker.id && !isSettled(t));
    if (open) throw new Error(`你已经在等架构师回答（${open.id}），一次只能问一个问题；别的问题写进同一个问题里。`);
    const id = nextPlanTaskId(usedTaskIds(store.root, store, flowId, config));
    handoffs[id] = consultBrief(question, kind, asker);
    return [{
      id, stage: flow.stage, kind: 'consult', role: 'architect', title: `咨询：${question.replace(/\s+/g, ' ').slice(0, 80)}`,
      scopes: [...config.role('architect').scopes], depends_on: [], inputs: [], writes: ['**', 'rules/**'], verify: [],
      ...(asker ? { for_task: asker.id } : {}),
    }];
  }, actor, handoffs);
  return task!;
}

const byId = (a: Pick<TaskFile, 'id'>, b: Pick<TaskFile, 'id'>) => Number(a.id.slice(2)) - Number(b.id.slice(2));

/**
 * 尽量一次只派一个架构师：有 architect 的任务在途（IN_FLIGHT：含咨询、S0 架构、它的修复）时，就绪的咨询都先不派；
 * 否则只放行编号最小的一个。返回要暂缓派发的咨询任务编号（纯函数）。
 * 不是严格串行：阻塞的任务不算在途（咨询 A 等用户时，咨询 B 照常派发），A 解除阻塞回到 in_progress 后重新派发也不经过这里。
 * 两个架构师同时写的改动各自经合并队列串行合入，冲突照常处理，不会丢代码。
 */
export function heldConsults(tasks: readonly Pick<TaskFile, 'id' | 'kind' | 'role' | 'status'>[]): Set<string> {
  const ready = tasks.filter((t) => t.kind === 'consult' && t.status === 'ready').sort(byId);
  const busy = tasks.some((t) => t.role === 'architect' && IN_FLIGHT.includes(t.status));
  return new Set((busy ? ready : ready.slice(1)).map((t) => t.id));
}

/** 咨询任务接着的会话：本流程里 architect 最近一次正常结束的运行所属的任务（S0 架构、它的修复或上一个咨询） */
export function lastArchitectTask(store: StateStore, flowId: string, exclude: string): string | null {
  const kinds = new Set(['impl', 'fix', 'consult']);
  const runs = store.listRuns().filter((r) => r.flow === flowId && r.role === 'architect' && r.ended_at && r.task !== exclude && (r.outcome === 'submitted' || r.outcome === 'timeout'))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const r of runs.reverse()) {
    const id = r.task;
    if (!id) continue;
    try { if (kinds.has(store.readTask(flowId, id).kind)) return id; } catch { /* 任务已不存在 */ }
  }
  return null;
}

/** 开新会话时放进咨询任务说明的 decisions.md（集成分支上的，取最近部分）；没有时返回空串 */
export function decisionsSection(root: string, store: StateStore, flowId: string): string {
  const text = readRel({ root, ref: store.readFlow(flowId).integration_branch }, DECISIONS_PATH)?.trim();
  if (!text) return '';
  return `## 之前的架构决定（${DECISIONS_PATH}${text.length > DECISIONS_TAIL ? '，只保留最近部分' : ''}）\n这次是新会话，先看这些记录了解之前回答过什么、改过什么。\n\n${text.slice(-DECISIONS_TAIL)}`;
}

export function readAnswer(store: StateStore, flowId: string, consultId: string): string | null {
  const abs = store.abs(`${evidenceRel(flowId, consultId)}/${ANSWER_FILE}`);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/** 提问任务最近一次提问对应的咨询任务 */
export const latestConsultOf = (tasks: readonly TaskFile[], askerId: string): TaskFile | undefined =>
  tasks.filter((t) => t.kind === 'consult' && t.for_task === askerId).sort(byId).at(-1);

/**
 * 用户可以代替架构师回答的咨询：阻塞了、但不是架构师在等用户决定（运行失败用尽、调度器交出来等，重新交给架构师可能还是一样）。
 * 架构师用 forge_block 问用户时，回答照常交回架构师，由它接着回答（kind=change 时还要它改公共内容）。
 */
export const userCanAnswer = (t: Pick<TaskFile, 'kind' | 'status' | 'blocked_by'>): boolean => t.kind === 'consult' && t.status === 'blocked' && t.blocked_by !== 'agent';

/** 用户代替架构师回答：回答存成咨询的回答、咨询结束；提问的任务由下一次程序步骤照常恢复（主会话的提问在 forge_wait 里拿到） */
export async function answerAsUser(store: StateStore, flowId: string, consultId: string, answer: string): Promise<string> {
  const c = store.readTask(flowId, consultId);
  if (c.status !== 'blocked') throw new Error(`咨询 ${consultId} 当前是 ${c.status}，不是 blocked。`);
  await store.saveEvidence(flowId, consultId, ANSWER_FILE, `（用户代替架构师回答）\n${answer.trim()}`, 'human');
  await store.transitionTask(flowId, consultId, { to: 'done', trigger: 'user_answer', actor: 'human' });
  // 咨询不再派发、工作区里的改动不合入：工作区与分支一并删掉（删不掉时留给 /forge doctor 报告，回答已经记下）
  if (c.worktree) try { removeWorktree(store.root, c.worktree, c.branch ?? undefined); } catch { /* 见上 */ }
  return `已用你的回答结束咨询 ${consultId}，${c.for_task ? `${c.for_task} 接着做` : '回答交给主会话'}。`;
}

/** 咨询结束、架构师没留下回答时给提问方的说明 */
export const noAnswerText = (c: Pick<TaskFile, 'id'>) =>
  `架构师没有回答你的问题（咨询任务 ${c.id} 没有留下回答）：自己判断能否继续，做不下去用 forge_block 说明。`;

/**
 * 程序步骤：咨询结束（done）后恢复在等它的任务——回答写进 handoff，集成分支同步进 worktree，
 * 任务回到 in_progress（没有租约），由引擎接着原会话重新派发。返回恢复的任务。
 * 每个提问任务单独处理：同步出错（worktree 不见了、合并失败又没有冲突文件）时它转为一般的阻塞（先交给主会话），不影响别的提问任务，也不在之后每次调度时重复报错。
 */
export async function resolveConsults(store: StateStore, flowId: string): Promise<string[]> {
  const out: string[] = [];
  const tasks = store.listTasks(flowId);
  for (const asker of tasks.filter((t) => t.status === 'blocked' && t.blocked_by === 'architect')) {
    const c = latestConsultOf(tasks, asker.id);
    if (c?.status !== 'done') continue;
    const answer = readAnswer(store, flowId, c.id)?.trim();
    const notes = [answer ? `架构师的回答（${c.id}）：\n${answer}` : noAnswerText(c)];
    let failed: string | null = null;
    if (asker.worktree && asker.base_sha) {
      try {
        const synced = await syncTaskInputs(store, flowId, asker);
        notes.push(synced.conflicts.length ? syncConflictText(synced.conflicts) : SYNCED_TEXT);
      } catch (e) {
        failed = `架构师已回答（${c.id}），但程序把集成分支同步进 ${asker.id} 的工作区时出错：${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`;
        notes.push(`${failed}。解除阻塞后接着做，需要架构师的修改时先调用 forge_sync。`);
      }
    }
    // 追加 handoff 与转移不在同一事务：上次追加后、转移前被杀，/forge-resume 后会再走一遍，这次的回答已经在 handoff 里就不再追加
    if (!store.readHandoff(flowId, asker.id).includes(notes[0]!)) await store.appendHandoff(flowId, asker.id, notes.join('\n\n'), 'engine');
    if (failed) await store.transitionTask(flowId, asker.id, { to: 'blocked', trigger: 'resume_failed', actor: 'engine', facts: { reason: failed } });
    else {
      await store.transitionTask(flowId, asker.id, { to: 'in_progress', trigger: 'answered', actor: 'engine' });
      out.push(asker.id);
    }
  }
  return out;
}

const SYNCED_TEXT = '程序已把集成分支（含架构师的修改）同步进你的工作区。';
const syncConflictText = (files: readonly string[]) => `程序把集成分支同步进你的工作区时有冲突，冲突标记留在：${files.join('、')}。先解决冲突，再调用 forge_sync 完成同步。`;

/** 接着原会话时告诉提问方工作区的同步情况：按 worktree 当前的实际状态（冲突标记、是否已含集成分支），不靠记录 */
export function answerSyncText(store: StateStore, flowId: string, t: Pick<TaskFile, 'worktree'>): string {
  const wt = t.worktree;
  if (!wt || !existsSync(wt)) return '';
  const conflicts = pendingConflicts(wt);
  if (conflicts.length) return syncConflictText(conflicts);
  return gitOk(wt, ['merge-base', '--is-ancestor', store.readFlow(flowId).integration_branch, 'HEAD']) ? SYNCED_TEXT
    : '集成分支还没有同步进你的工作区：需要架构师的修改时先调用 forge_sync。';
}

/** 给主会话的回答：主会话提问的咨询已完成、还没在 forge_wait 里交给它的 */
export function undeliveredAnswers(store: StateStore, flowId: string): { task: string; answer: string }[] {
  const delivered = new Set(store.readEvents().filter((e) => e.flow === flowId && typeof e.data?.['consult_delivered'] === 'string').map((e) => String(e.data!['consult_delivered'])));
  return store.listTasks(flowId).filter((t) => t.kind === 'consult' && !t.for_task && t.status === 'done' && !delivered.has(t.id))
    .sort(byId).map((t) => ({ task: t.id, answer: readAnswer(store, flowId, t.id)?.trim() ?? '（没有回答）' }));
}

/** 取出还没交给主会话的回答并记为已交付，在同一事务里：Pi 并行执行同一条消息里的两次 forge_wait 时，回答只交一次 */
export async function takeUndelivered(store: StateStore, flowId: string): Promise<{ task: string; answer: string }[]> {
  if (!undeliveredAnswers(store, flowId).length) return [];
  return store.recordEventsWith(() => {
    const result = undeliveredAnswers(store, flowId);
    return { result, events: result.map((a) => ({ flow: flowId, task: a.task, actor: 'orchestrator', type: 'note' as const, reason: `架构师的回答已交给主会话（${a.task}）`, data: { consult_delivered: a.task } })) };
  });
}

/** 主会话提问、架构师还在回答的咨询（阻塞的不算：它等主会话或用户处理，不是等回答） */
export const openMainConsults = (tasks: readonly TaskFile[]): TaskFile[] =>
  tasks.filter((t) => t.kind === 'consult' && !t.for_task && !['done', 'cancelled', 'blocked'].includes(t.status));

/** 提问任务在等的咨询阻塞了（失败用尽、架构师 forge_block、合并失败等）：返回这个咨询；还在回答或已结束（程序会恢复提问任务）时返回 undefined */
export function stalledConsultOf(tasks: readonly TaskFile[], asker: TaskFile): TaskFile | undefined {
  if (asker.status !== 'blocked' || asker.blocked_by !== 'architect') return undefined;
  const c = latestConsultOf(tasks, asker.id);
  return c?.status === 'blocked' ? c : undefined;
}
/** 在等架构师回答、由程序推进的任务；它的咨询阻塞时不算（要有人先处理咨询） */
export const waitingOnArchitect = (tasks: readonly TaskFile[], t: TaskFile): boolean =>
  t.status === 'blocked' && t.blocked_by === 'architect' && !stalledConsultOf(tasks, t);
export const stalledText = (c: Pick<TaskFile, 'id' | 'blocked_reason'>, n = 160): string => {
  const why = (c.blocked_reason ?? '').replace(/\s+/g, ' ');
  return `咨询 ${c.id} 已阻塞：${why.length > n ? `${why.slice(0, n)}…` : why}`;
};
