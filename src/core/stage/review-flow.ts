// 逐任务审查的流程部分：决定是否审查、创建 .rv / .rv-n（页面任务按页拆成 .rv.<序号>）、处理审查结论（通过、打回、轮数用尽）、把 suggest 记入集成分支。
// 结论存为 .rv task 的 evidence（review-input.json、review-report.json、review-confirm.json），不新增 schema；状态只经 StateStore 写入。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { ReviewFinding, TaskFile } from '../state/schemas.ts';
import { evidenceRel, type StateStore, type TaskInput } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { commitFilesToBranch } from '../spec/intake.ts';
import { headSha } from '../workspace/worktree.ts';
import { acceptanceAudit, reviewTestPlan } from './review-tests.ts';
import { matchesAny, writesOwnAcceptance } from '../state/paths.ts';
import { acTexts, pageOf, readPrd, type Prd } from '../spec/prd.ts';
import {
  CONTRACT_SNIPPET_MAX, OPENAPI_PATH, PAGE_API_PATH, SHARED_PART, buildReviewBrief, domainApiSnippet, pageApiSection, contractFilesFor, fitSnippets, latestReviewRound, mustHandoff, mustOf, nextReviewRound,
  reviewIdOf, reviewMode, reviewPolicy, reviewRoundOf, reviewSlotOf, splitPageCommits, stripAcceptanceDiff, suggestionLine, truncateDiff,
  type ConfirmItem, type PageMaterial, type ReviewBriefInput, type ReviewMode, type ReviewPart, type TaskCommit,
} from './review.ts';

export const REVIEW_INPUT = 'review-input.json';
export const REVIEW_REPORT = 'review-report.json';
export const REVIEW_CONFIRM = 'review-confirm.json';
export const REVIEW_FILES = { input: REVIEW_INPUT, report: REVIEW_REPORT, confirm: REVIEW_CONFIRM } as const;
export const SUGGESTIONS_PATH = 'docs/review/suggestions.md';

/** 创建 .rv 时存下的输入：确认轮的上一轮 must 清单，以及这一轮审查的提交范围 */
export interface ReviewInputFile { round: number; base: string; head: string; prior_must: ReviewFinding[] }
export interface ReviewReportFile { round: number; requested: 'pass' | 'changes'; verdict: 'pass' | 'changes'; issues: ReviewFinding[]; head: string }
export interface ReviewConfirmFile { round: number; items: ConfirmItem[]; unresolved: string[]; head: string }

export function readReviewEvidence<T>(store: StateStore, flowId: string, taskId: string, name: string): T | null {
  const abs = store.abs(`${evidenceRel(flowId, taskId)}/${name}`);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')) as T; } catch { return null; }
}

export const readReviewInput = (store: StateStore, flowId: string, rvId: string) => readReviewEvidence<ReviewInputFile>(store, flowId, rvId, REVIEW_INPUT);

/** 一个已结束的审查 task 留下的、尚未解决的 must；没有结论时返回 null */
export function unresolvedAfter(store: StateStore, flowId: string, rvId: string): ReviewFinding[] | null {
  const report = readReviewEvidence<ReviewReportFile>(store, flowId, rvId, REVIEW_REPORT);
  if (report) return mustOf(report.issues);
  const confirm = readReviewEvidence<ReviewConfirmFile>(store, flowId, rvId, REVIEW_CONFIRM);
  const input = readReviewInput(store, flowId, rvId);
  if (confirm && input) return input.prior_must.filter((m) => confirm.unresolved.includes(m.id));
  return null;
}


/**
 * 提交时是否需要审查，以及强度（impl 一律审查，审查者运行本 task 自己的测试）。
 * 已有审查记录时看最新一轮（按页审查时一轮有几个）：还有未解决的 must 则继续确认轮（沿用强度）；都已通过、之后又返工（合并冲突由 worker 解决）的不再审查，
 * 解决得对不对由阶段门禁的全量测试与验收测试检查，与 merge-fix 一样。重新审查会是新的第一轮，提出之前各轮没提的问题
 * （stock run-04：5 次冲突后的审查有 3 次提了新的 must，T-004 因此用完轮数交给用户）。
 * 没有记录时按 review.ts 的规则推导。
 */
export function decideReview(store: StateStore, config: FlowConfig, flowId: string, t: TaskFile): ReviewMode {
  const tasks = store.listTasks(flowId);
  const round = latestReviewRound(tasks, t.id);
  if (round.length) {
    const mode = round[0]!.review ?? 'auto';
    if (round.some((rv) => rv.status !== 'done')) return mode;
    // 轮数用尽后被 accept 放行：留下的问题已被接受，之后合并冲突交回、解决后再提交的，同审查通过一样不再审查
    if (store.readEvents().some((e) => e.task === t.id && e.trigger === 'accept' && e.to === 'queued_merge')) return 'skip';
    return round.every((rv) => unresolvedAfter(store, flowId, rv.id)?.length === 0) ? 'skip' : mode;
  }
  return reviewMode(t, tasks, reviewPolicy(config));
}

function showAt(wt: string, rel: string): string {
  try { return git(wt, ['show', `HEAD:${rel}`]); } catch { return ''; }
}

/** 建一轮审查时共用的信息 */
interface RoundCtx {
  store: StateStore; flowId: string; tasks: TaskFile[];
  orig: TaskFile & { worktree: string; base_sha: string };
  head: string; round: number;
  /** 验收测试由 worker 自己写时，审查者要读这些测试，diff 里不再排除 tests/acceptance */
  ownTests: boolean;
  prd: () => Prd;
}

/** 一轮里的一个审查任务 */
interface ReviewDraft { id: string; page?: string; title: string; base: string; priorMust: ReviewFinding[]; brief: ReviewBriefInput }

const filesBetween = (wt: string, a: string, b: string) => git(wt, ['diff', '--name-only', '-z', a, b]).split('\0').filter(Boolean);
const excludeTests = (c: RoundCtx) => (c.ownTests ? [] : [':(exclude)tests/acceptance']);
const cleanDiff = (c: RoundCtx, raw: string) => truncateDiff(c.ownTests ? raw : stripAcceptanceDiff(raw));

/**
 * 第一轮的审查材料（按任务种类组装）：AC 原文、相关契约、跨 task 的提醒；页面任务另带页面材料与按页拆分的说明。
 * files 是这个审查管的文件（跨 task 的提醒只看它们）。
 */
function firstRoundBrief(c: RoundCtx, d: { id: string; title: string; diff: ReviewBriefInput['diff']; files: string[]; pages?: PageMaterial[]; part?: ReviewPart }): ReviewBriefInput {
  const { orig, head } = c;
  const wt = orig.worktree;
  const all = git(wt, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/contracts']).split('\n').filter(Boolean);
  const touched = git(wt, ['diff', '--name-only', orig.base_sha, head, '--', 'docs/contracts']).split('\n').filter(Boolean);
  const sharedEdits = sharedRewrites(wt, orig, head, d.files);
  // 后端 domain 任务（不改契约，没有 module）：openapi.yaml 里本 domain 的接口在前，拆到 paths/<domain>.yaml 的按文件名带上
  const api = orig.domain ? domainApiSnippet(showAt(wt, OPENAPI_PATH), orig.domain, orig.ac ?? []) : [];
  return {
    taskId: orig.id, title: d.title, reviewId: d.id, acIds: orig.ac ?? [], acTexts: acTexts(c.prd(), orig.ac ?? []),
    contracts: fitSnippets([...api, ...contractFilesFor(orig.module ?? orig.domain, all, touched).map((p) => ({ path: p, content: showAt(wt, p) })).filter((f) => f.content)], CONTRACT_SNIPPET_MAX),
    deviations: orig.deviations ?? [], range: { from: orig.base_sha, to: head }, diff: d.diff, priorMust: [],
    ...(c.ownTests ? { acceptance: acceptanceAudit(orig) ?? undefined, withAcceptance: true } : {}),
    ...crossTaskInputs(c.tasks, orig, d.files),
    ...(sharedEdits.length ? { sharedEdits } : {}),
    ...(d.pages?.length ? { pages: d.pages } : {}),
    ...(d.part ? { part: d.part } : {}),
  };
}

/** 一页的审查材料：原型路径、page-api.md 里这一页、这一页对应需求的 AC 原文 */
function pageMaterial(c: RoundCtx, page: string, api: string): PageMaterial {
  const prd = c.prd();
  const p = pageOf(prd, page);
  const ids = [...new Set((p?.reqs ?? []).flatMap((req) => prd.reqs.filter((r) => r.id === req).flatMap((r) => r.acs.map((a) => `${req}.${a.id}`))))];
  const texts = acTexts(prd, ids);
  return { id: page, prototype: p?.file || null, api: api ? pageApiSection(api, page) : null, acs: ids.map((id) => ({ id, text: texts[id] ?? null })) };
}

/** 整份的第一轮：任务基线到提交的 diff；页面任务退回整批审查时带上全部页面的材料 */
function wholeDraft(c: RoundCtx, part?: ReviewPart): ReviewDraft {
  const { orig, head } = c;
  const id = reviewIdOf(orig.id, c.round);
  const raw = git(orig.worktree, ['diff', '--no-color', '--no-ext-diff', orig.base_sha, head, '--', '.', ...excludeTests(c)]);
  const api = orig.pages?.length ? showAt(orig.worktree, PAGE_API_PATH) : '';
  const brief = firstRoundBrief(c, { id, title: orig.title, diff: cleanDiff(c, raw), files: filesBetween(orig.worktree, orig.base_sha, head),
    pages: (orig.pages ?? []).map((p) => pageMaterial(c, p, api)), ...(part ? { part } : {}) });
  return { id, title: orig.title, base: orig.base_sha, priorMust: [], brief };
}

/** 页面任务分支自己的提交（--first-parent 排除提交前同步集成分支时经合并带进来的别的任务的提交），按提交顺序 */
function taskCommits(wt: string, base: string, head: string): TaskCommit[] {
  return git(wt, ['log', '--first-parent', '--no-merges', '--reverse', '--format=%H%x1f%s', `${base}..${head}`]).split('\n').filter(Boolean)
    .map((l) => { const [sha, subject] = l.split('\x1f'); return { sha: sha!, subject: subject ?? '' }; });
}

/** 几个 commit 各自的 diff 依次拼起来（同一个文件可能被几个 commit 改到），以及它们改到的文件 */
function commitsDiff(c: RoundCtx, commits: readonly TaskCommit[]): { diff: ReviewBriefInput['diff']; files: string[] } {
  const wt = c.orig.worktree;
  const raw = commits.map((k) => `# commit ${k.sha.slice(0, 8)} ${k.subject}\n${git(wt, ['show', '--no-color', '--no-ext-diff', '--format=', k.sha, '--', '.', ...excludeTests(c)])}`).join('\n');
  const files = [...new Set(commits.flatMap((k) => git(wt, ['show', '--name-only', '--format=', k.sha]).split('\n').filter(Boolean)))];
  return { diff: cleanDiff(c, raw), files };
}

/**
 * 页面任务的第一轮：按提交说明的 [page:<id>] 每页一个审查（序号是页面在 pages 里的位置），[shared] 与没标记的 commit 一个公共部分的审查（序号 0，没有这类 commit 时不建）。
 * 有任何一页找不到自己的 commit 时退回整批一次审查（漏标的那页的改动会落进公共部分，没人对照原型审它），并提醒前端；不拦提交。
 */
async function pageDrafts(c: RoundCtx): Promise<ReviewDraft[]> {
  const { orig, head } = c;
  const pages = orig.pages!;
  const split = splitPageCommits(taskCommits(orig.worktree, orig.base_sha, head), pages);
  const stray = split.stray.map((s) => `${s.commit.sha.slice(0, 8)}（[page:${s.page}]）`);
  if (split.missing.length || split.stray.length) {
    const why = split.missing.length ? `这些页面找不到说明以 [page:<页面 id>] 开头的 commit：${split.missing.join('、')}，这次退回整批审查` : `这些 commit 标记的页面不在本任务的页面清单（${pages.join('、')}）里，当作公共部分审查：${stray.join('、')}`;
    await c.store.recordEvent({ flow: c.flowId, task: orig.id, actor: 'engine', type: 'note', reason: `commit 没有按约定标记：${why}`,
      data: { kind: 'page_commit_marks', missing: split.missing, stray: split.stray.map((s) => s.page) } });
    if (split.missing.length) {
      await c.store.appendHandoff(c.flowId, orig.id, `提醒：commit 没有按约定标记，退回整批审查。${why}。之后每做完一页提交一次 commit，说明以 \`[page:<页面 id>]\` 开头；公共组件与样式单独提交，说明以 \`[shared]\` 开头。`, 'engine');
      return [wholeDraft(c, { kind: 'fallback', missing: split.missing })];
    }
  }
  const api = showAt(orig.worktree, PAGE_API_PATH);
  const drafts = split.pages.map(({ page, commits }, k): ReviewDraft => {
    const id = reviewIdOf(orig.id, c.round, k + 1);
    const title = `${orig.title}：页面 ${page}`;
    return { id, page, title, base: orig.base_sha, priorMust: [], brief: firstRoundBrief(c, { id, title, ...commitsDiff(c, commits), pages: [pageMaterial(c, page, api)], part: { kind: 'page', page, pages } }) };
  });
  if (split.shared.length) {
    const id = reviewIdOf(orig.id, c.round, 0);
    const title = `${orig.title}：公共部分`;
    const design = git(orig.worktree, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter((f) => /(^|\/)(DESIGN\.md|theme\.css)$/.test(f));
    drafts.unshift({ id, page: SHARED_PART, title, base: orig.base_sha, priorMust: [], brief: firstRoundBrief(c, { id, title, ...commitsDiff(c, split.shared), part: { kind: 'shared', pages, design, stray } }) });
  }
  return drafts;
}

/** 确认轮：上一轮这个审查留下的 must，加上一轮之后的增量 diff */
function confirmDraft(c: RoundCtx, prev: TaskFile, priorMust: ReviewFinding[]): ReviewDraft {
  const { orig, head, store, flowId } = c;
  const wt = orig.worktree;
  const id = reviewIdOf(orig.id, c.round, reviewSlotOf(prev.id));
  const from = readReviewInput(store, flowId, prev.id)?.head ?? orig.base_sha;
  // 增量 diff 只含本 task 自己的改动：worker 返工前同步过集成分支，上一轮之后合入的别人的文件（包括 docs/review/suggestions.md）不算
  const own = new Set(filesBetween(wt, orig.base_sha, head));
  const files = filesBetween(wt, from, head).filter((f) => own.has(f));
  const raw = files.length ? git(wt, ['diff', '--no-color', '--no-ext-diff', from, head, '--', ...files, ...excludeTests(c)]) : '';
  const title = prev.page ? `${orig.title}：${prev.page === SHARED_PART ? '公共部分' : `页面 ${prev.page}`}` : orig.title;
  return { id, ...(prev.page ? { page: prev.page } : {}), title, base: from, priorMust, brief: {
    taskId: orig.id, title, reviewId: id, acIds: orig.ac ?? [], acTexts: {}, contracts: { shown: [], omitted: [] }, deviations: orig.deviations ?? [],
    range: { from, to: head }, diff: cleanDiff(c, raw), priorMust, ...(c.ownTests ? { withAcceptance: true } : {}),
  } };
}

/**
 * 创建下一轮审查 task：只读，工作目录指向原 task 的 worktree（dispatch 时设置），输入写进 handoff，提交范围存为 evidence。
 * 上一轮有未解决的 must 时，只为这些审查建确认轮（按页审查时只确认有 must 的页面与公共部分）；否则是第一轮：
 * 页面任务按页拆开（见 pageDrafts），其余一个整份的审查。一轮的审查一次建好；只有一个审查者运行本 task 的测试（公共部分优先），其余并行只读代码。
 */
export async function createReviewRound(root: string, store: StateStore, config: FlowConfig, flowId: string, orig: TaskFile, mode: Exclude<ReviewMode, 'skip'>, actor = 'engine'): Promise<TaskFile[]> {
  if (!orig.worktree || !orig.base_sha) throw new Error(`任务 ${orig.id} 没有 worktree，无法审查`);
  const tasks = store.listTasks(flowId);
  const branch = store.readFlow(flowId).integration_branch;
  let prd: Prd | null = null;
  const c: RoundCtx = { store, flowId, tasks, orig: orig as RoundCtx['orig'], head: headSha(orig.worktree), round: nextReviewRound(tasks, orig.id),
    ownTests: writesOwnAcceptance(orig), prd: () => (prd ??= readPrd(root, `refs/heads/${branch}`)) };
  const pending = latestReviewRound(tasks, orig.id).map((rv) => ({ rv, must: unresolvedAfter(store, flowId, rv.id) ?? [] })).filter((x) => x.must.length);
  const drafts = pending.length ? pending.map((x) => confirmDraft(c, x.rv, x.must)) : orig.pages?.length ? await pageDrafts(c) : [wholeDraft(c)];
  const runner = drafts[0]!;
  const tests = reviewTestPlan(config, orig, branch);
  for (const d of drafts) {
    if (d === runner) d.brief.tests = tests;
    else d.brief.testsBy = runner.id;
  }
  const inputs = drafts.map((d): TaskInput => ({
    id: d.id, stage: orig.stage, kind: 'review', role: 'reviewer', title: `审查：${d.title}`, scopes: [...config.role('reviewer').scopes],
    depends_on: [], inputs: [], writes: [], verify: [], for_task: orig.id, ac: [...(orig.ac ?? [])],
    ...(d.page ? { page: d.page } : {}),
    ...(orig.description ? { description: orig.description } : {}),
    ...(orig.module ? { module: orig.module } : {}),
    ...(orig.layers?.length ? { layers: [...orig.layers] } : {}),
    // 标记：strong 在派发时使用升级模型（dispatcher.planModel）
    review: mode,
  }));
  const created = await store.addTasks(flowId, inputs, actor);
  for (const d of drafts) {
    const file: ReviewInputFile = { round: c.round, base: d.base, head: c.head, prior_must: d.priorMust };
    await store.saveEvidence(flowId, d.id, REVIEW_INPUT, JSON.stringify(file, null, 2), actor);
    await store.appendHandoff(flowId, d.id, buildReviewBrief(d.brief), actor);
  }
  return created;
}

/** 第一轮审查要看的跨 task 信息：diff 里落在已完成的其他 task 负责范围内的文件（文档与验收测试除外，最多 15 个） */
export function crossTaskInputs(tasks: readonly TaskFile[], orig: TaskFile, files: readonly string[]): Pick<ReviewBriefInput, 'othersFiles'> {
  // architect 的 writes 含 `**`，算进来每个文件都会标成它负责
  const done = tasks.filter((t) => t.id !== orig.id && t.kind === 'impl' && t.status === 'done' && t.role !== 'architect' && t.writes.length);
  const othersFiles = files.filter((f) => !f.startsWith('docs/') && !f.startsWith('tests/acceptance/'))
    .map((file) => ({ file, owners: done.filter((t) => matchesAny(file, t.writes)).map((t) => t.id) }))
    .filter((f) => f.owners.length).slice(0, 15);
  return othersFiles.length ? { othersFiles } : {};
}

/**
 * plan.md 的公共文件（shared）不拦：改动不只是追加（删除或修改了已有的行）的，列给 reviewer 看一眼。
 * 并行的任务都会往这些文件里追加，改已有内容可能破坏别人的用法；只提醒，不拦。
 */
export function sharedRewrites(wt: string, orig: Pick<TaskFile, 'base_sha' | 'shared'>, head: string, files: readonly string[]): string[] {
  if (!orig.base_sha || !orig.shared?.length) return [];
  return files.filter((f) => matchesAny(f, orig.shared!)).filter((f) => {
    const [, deleted] = git(wt, ['diff', '--numstat', orig.base_sha!, head, '--', f]).trim().split('\t');
    return !!deleted && deleted !== '0';
  });
}

/** 把 suggest 追加到集成分支的 docs/review/suggestions.md（每条带 task 与 R 编号；同一条不重复追加）。与合并并发时重试。 */
export function appendSuggestions(root: string, branch: string, rvId: string, taskId: string, suggestions: readonly ReviewFinding[]): boolean {
  if (!suggestions.length) return false;
  const ref = `refs/heads/${branch}`;
  for (let attempt = 0; ; attempt++) {
    const old = gitOk(root, ['cat-file', '-e', `${ref}:${SUGGESTIONS_PATH}`])
      ? git(root, ['show', `${ref}:${SUGGESTIONS_PATH}`])
      : '# 审查建议（suggest）\n\n不阻塞合并，阶段签收时列给用户挑选；每条带审查 task 与 R 编号。\n';
    const fresh = suggestions.filter((s) => !old.includes(`[${rvId} ${s.id}]`));
    if (!fresh.length) return false;
    const text = `${old.replace(/\n*$/, '\n')}\n## ${taskId}（${rvId}）\n\n${fresh.map((s) => suggestionLine(rvId, taskId, s)).join('\n')}\n`;
    try {
      return commitFilesToBranch(root, branch, [{ rel: SUGGESTIONS_PATH, content: text }], `pi-forge: 记录 ${taskId} 的审查建议（${rvId}）`) !== null;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
}

/**
 * 某一轮审查的结论是否已经被处理：这一轮最后一个审查 task 提交结论（report）之后，原 task 有过 review_changes 或 review_pass
 * （转移本身就是标记，崩溃后不会重复处理；按页审查时一轮的审查都结束后才处理，所以看最后一个提交的）。
 */
export function reviewResolved(store: StateStore, flowId: string, taskId: string, rvIds: readonly string[]): boolean {
  const ids = new Set(rvIds);
  const events = store.readEvents().filter((e) => e.flow === flowId);
  const reported = events.findLast((e) => !!e.task && ids.has(e.task) && e.type === 'transition' && e.trigger === 'report');
  if (!reported) return false;
  return events.some((e) => e.seq > reported.seq && e.task === taskId && e.type === 'transition' && (e.trigger === 'review_changes' || e.trigger === 'review_pass'));
}

const brief1 = (m: ReviewFinding) => `${m.id} ${m.problem.replace(/\s+/g, ' ').slice(0, 120)}`;
/** 按页审查时 must 的编号前加上页面（公共部分是 shared），各页的 R-1 不撞号 */
const partLabel = (rv: Pick<TaskFile, 'page'>, id: string) => (rv.page ? `${rv.page === SHARED_PART ? 'shared' : rv.page}/${id}` : id);

/**
 * 处理审查结论（pump 的一步，类似 resolveDisputes）。对每个 in_review 的 task：
 * - 还没有审查 task（刚提交，或崩溃恢复）：创建下一轮（一个，或按页的几个）；
 * - 最新一轮的审查都 done 之后一起处理：都没有未解决的 must → review_pass（→ queued_merge）；有 → 所有 must（按页审查时编号带上页面）汇总成一次
 *   review_changes（→ in_progress，must 清单写进 handoff，worker 接着原会话一起改）；review_rounds 达到 review.max_rounds 时状态机自动转 blocked
 *   （blocked_by = review_exhausted，用户可 /forge accept）；
 * - 审查者 forge_block：只有审查 task 阻塞，原 task 留在 in_review 等它（原来一并阻塞：club run-02 主会话对两者各 retry 一次，worker 与 reviewer 在同一个 worktree 里同时运行）。
 * 轮数的计法：第 k 轮审查（.rv 是第 1 轮，.rv-k 是第 k 轮）结束时仍有 must，则 review_rounds = k；k < max_rounds 打回，k = max_rounds 用尽。轮数按原 task 计，一轮有几个审查也只算一轮。
 */
export async function resolveReviews(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string[]> {
  const out: string[] = [];
  const branch = store.readFlow(flowId).integration_branch;
  for (const listed of store.listTasks(flowId)) {
    if (listed.status !== 'in_review') continue;
    const t = store.readTask(flowId, listed.id);
    if (t.status !== 'in_review') continue;
    const round = latestReviewRound(store.listTasks(flowId), t.id);
    const settled = round.length > 0 && round.every((rv) => rv.status === 'done');
    // 没有审查 task，或最新一轮的结论已经处理过（原 task 返工后再次提交，重新回到 in_review）：创建下一轮
    if (!round.length || (settled && reviewResolved(store, flowId, t.id, round.map((rv) => rv.id)))) {
      const mode = decideReview(store, config, flowId, t);
      await createReviewRound(root, store, config, flowId, t, mode === 'skip' ? 'auto' : mode);
      out.push(t.id);
      continue;
    }
    if (!settled) continue;
    const results = round.map((rv) => ({ rv, left: unresolvedAfter(store, flowId, rv.id) }));
    const silent = results.find((r) => r.left === null);
    if (silent) {
      await store.transitionTask(flowId, t.id, { to: 'blocked', trigger: 'block', actor: 'engine', facts: { reason: `审查 ${silent.rv.id} 已结束但没有留下结论，请检查后 /forge unblock ${t.id}` } });
      out.push(t.id);
      continue;
    }
    for (const { rv } of results) {
      const report = readReviewEvidence<ReviewReportFile>(store, flowId, rv.id, REVIEW_REPORT);
      if (report) appendSuggestions(root, branch, rv.id, t.id, report.issues.filter((i) => i.level === 'suggest'));
    }
    const left: ReviewFinding[] = [];
    const notes: string[] = [];
    const noteOf = new Map<string, string>();
    for (const { rv, left: l } of results) {
      left.push(...l!.map((m) => ({ ...m, id: partLabel(rv, m.id) })));
      const confirm = readReviewEvidence<ReviewConfirmFile>(store, flowId, rv.id, REVIEW_CONFIRM);
      for (const i of confirm?.items ?? []) {
        if (i.resolved || !i.note?.trim()) continue;
        noteOf.set(partLabel(rv, i.id), i.note.replace(/\s+/g, ' ').trim());
        notes.push(`- ${partLabel(rv, i.id)}：${i.note.trim()}`);
      }
    }
    if (!left.length) {
      await store.transitionTask(flowId, t.id, { to: 'queued_merge', trigger: 'review_pass', actor: 'engine', facts: { unresolved_must: 0 } });
    } else {
      const k = reviewRoundOf(round[0]!.id);
      const ids = round.map((rv) => rv.id).join('、');
      // 后一轮审查者对未解决条目的说明比首轮的原问题新：stock run-02 首轮写"上限是 50"，第二轮已确认改成 30、只差测试，原因却还显示 50，主会话只好自己澄清
      const brief = (m: ReviewFinding) => (noteOf.has(m.id) ? `${m.id}（本轮说明）${noteOf.get(m.id)!.slice(0, 240)}（原问题：${m.problem.replace(/\s+/g, ' ').slice(0, 60)}）` : brief1(m));
      const reason = `审查第 ${k} 轮（${ids}）仍有 ${left.length} 条 must 未解决：${left.map(brief).join('；')}`.slice(0, 1500);
      const after = await store.transitionTask(flowId, t.id, { to: 'in_progress', trigger: 'review_changes', actor: 'engine', facts: { unresolved_must: left.length, reason } });
      const split = round.some((rv) => rv.page) ? ['按页审查：编号前是页面 id（shared 是公共部分）；各页的问题一起改完后 forge_submit 一次。'] : [];
      await store.appendHandoff(flowId, t.id, [mustHandoff(k, left, after.status === 'blocked'), ...split, ...(notes.length ? [`审查者对未解决条目的说明：\n${notes.join('\n')}`] : [])].join('\n\n'), 'engine');
    }
    out.push(t.id);
  }
  return out;
}

export const reviewWorktreeOf = (store: StateStore, flowId: string, rv: Pick<TaskFile, 'for_task'>): { path: string; branch: string; base_sha: string } | null => {
  if (!rv.for_task) return null;
  const orig = store.readTask(flowId, rv.for_task);
  if (!orig.worktree || !orig.branch || !orig.base_sha || !existsSync(path.resolve(orig.worktree))) return null;
  return { path: orig.worktree, branch: orig.branch, base_sha: orig.base_sha };
};
