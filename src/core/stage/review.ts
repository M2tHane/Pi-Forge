// 逐任务审查的纯函数部分：是否审查、问题编号、第二轮的确认校验、reviewer 的输入组装（10.2）。
// 第二轮只确认、must 必须有出处。不依赖 Pi，不读写 .forge。
import type { FlowConfig } from '../state/config.ts';
import type { ReviewFinding, TaskFile } from '../state/schemas.ts';
import { escalationPolicy, hardFanout } from '../insight/cost-control.ts';
import type { AcceptanceAudit, ReviewTestPlan } from './review-tests.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type ReviewMode = 'skip' | 'auto' | 'strong';

/** 审查输入的上限（diff 最多 2 万字） */
export const REVIEW_DIFF_MAX = 20_000;
export const CONTRACT_SNIPPET_MAX = 8_000;

// —— 10.1 什么时候审查 ——

export interface ReviewPolicy {
  /** escalation.critical_fanout：被这么多 task 硬依赖视为底座；0 关闭 */
  criticalFanout: number;
  /** review.max_rounds：审查轮数上限（第 1 轮出清单，之后各轮只确认） */
  maxRounds: number;
}

export function reviewPolicy(config: FlowConfig): ReviewPolicy {
  return {
    criticalFanout: escalationPolicy(config).criticalFanout,
    maxRounds: config.raw.review?.max_rounds ?? 2,
  };
}

/** 这些类型的 task 不做逐任务审查：fix（.fx-n，审查任务编号 T-001.fx-1.rv 不符合编号规则，回归由阶段门禁和 stage-qa 的确认轮核对）、doc 不是实施代码，review/qa 本身是审查；consult（架构师咨询）不审查，改动由批次门禁的 contract_check 与 stage-qa 兜底 */
const NO_REVIEW_KINDS: readonly string[] = ['fix', 'merge-fix', 'doc', 'review', 'qa', 'consult'];

/**
 * 推导一个 impl task 的审查强度（审查者读 diff 并运行本 task 自己的测试）。
 * review: skip 只由程序写在"接入真实接口"任务上（由本批的浏览器验收检查）；task.review 写了 strong 以它为准；
 * 否则：底座（被 critical_fanout 个 task 硬依赖）、layers 含 auth、risk=high → strong；其余 auto。
 */
export function reviewMode(task: Pick<TaskFile, 'id' | 'kind' | 'review' | 'risk' | 'size' | 'layers' | 'depends_on'>, tasks: readonly TaskFile[], policy: ReviewPolicy): ReviewMode {
  if (NO_REVIEW_KINDS.includes(task.kind)) return 'skip';
  if (task.review) return task.review;
  const fanout = hardFanout(task as TaskFile, tasks);
  if ((policy.criticalFanout > 0 && fanout >= policy.criticalFanout) || (task.layers ?? []).includes('auth') || task.risk === 'high') return 'strong';
  return 'auto';
}

// —— reviewer 的输出：问题与出处 ——

export interface ReviewIssueInput {
  level: 'must' | 'suggest';
  basis: string;
  files: readonly string[];
  location: string;
  problem: string;
  expected: string;
  /** stage-qa 判断的归属（frontend、domain 名或 unknown） */
  owner?: string;
}
/** 给问题编号 R-<start>…。级别与出处照 reviewer 写的保存，程序不校验出处 */
export function classifyIssues(inputs: readonly ReviewIssueInput[], start = 1): ReviewFinding[] {
  return inputs.map((i, n): ReviewFinding => ({
    id: `R-${start + n}`, level: i.level, basis: i.basis.trim() || '（未写出处）', files: [...i.files],
    location: i.location.trim(), problem: i.problem.trim(), expected: i.expected.trim(),
    ...(i.owner?.trim() ? { owner: i.owner.trim() } : {}),
  }));
}

export const mustOf = (issues: readonly ReviewFinding[]): ReviewFinding[] => issues.filter((i) => i.level === 'must');

/** 最终结论由程序按问题决定：没有 must 就是 pass（即使 reviewer 写了 changes）；有 must 就是 changes（即使写了 pass） */
export const effectiveVerdict = (issues: readonly ReviewFinding[]): 'pass' | 'changes' => (mustOf(issues).length ? 'changes' : 'pass');

export interface ConfirmItem { id: string; resolved: boolean; note?: string }

/** 第二轮的确认校验：每个编号必须是上一轮的 must，不能重复，必须覆盖全部；返回错误列表（空表示通过） */
export function validateConfirm(items: readonly ConfirmItem[], priorIds: readonly string[]): string[] {
  const errors: string[] = [];
  const prior = new Set(priorIds);
  const seen = new Set<string>();
  const unknown = items.map((i) => i.id).filter((id) => !prior.has(id));
  if (unknown.length) errors.push(`这些编号不在上一轮的清单里（第二轮不能提出新问题）：${[...new Set(unknown)].join('、')}`);
  for (const i of items) {
    if (seen.has(i.id) && prior.has(i.id)) errors.push(`编号 ${i.id} 重复了`);
    seen.add(i.id);
  }
  const missing = priorIds.filter((id) => !seen.has(id));
  if (missing.length) errors.push(`还没有回答这些编号：${missing.join('、')}`);
  return errors;
}

// —— 轮次与编号 ——

/** T-003.rv → 1，T-003.rv-2 → 2，按页审查的 T-003.rv-2.1 → 2；不是审查 task 返回 0 */
export function reviewRoundOf(id: string): number {
  const m = /\.rv(?:-(\d+))?(?:\.\d+)?$/.exec(id);
  return m ? Number(m[1] ?? 1) : 0;
}

/** 按页审查的序号：T-003.rv.2 是 pages 里的第 2 页，T-003.rv.0 是公共部分；整份审查（T-003.rv、T-003.rv-2）返回 null */
export function reviewSlotOf(id: string): number | null {
  const m = /\.rv(?:-\d+)?\.(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** 第 round 轮审查的编号；slot 是按页审查的序号（见 reviewSlotOf） */
export const reviewIdOf = (taskId: string, round: number, slot: number | null = null): string =>
  `${taskId}.rv${round > 1 ? `-${round}` : ''}${slot === null ? '' : `.${slot}`}`;

/** 某个 task 的审查 task（忽略已取消的），按轮次、序号排序 */
export function reviewTasksOf<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], taskId: string): T[] {
  return tasks.filter((t) => t.kind === 'review' && t.for_task === taskId && t.status !== 'cancelled')
    .sort((a, b) => reviewRoundOf(a.id) - reviewRoundOf(b.id) || (reviewSlotOf(a.id) ?? -1) - (reviewSlotOf(b.id) ?? -1));
}

/** 最新一轮的审查 task（按页审查时一轮有几个）；还没有审查时为空 */
export function latestReviewRound<T extends Pick<TaskFile, 'id' | 'kind' | 'for_task' | 'status'>>(tasks: readonly T[], taskId: string): T[] {
  const all = reviewTasksOf(tasks, taskId);
  const last = reviewRoundOf(all.at(-1)?.id ?? '');
  return all.filter((t) => reviewRoundOf(t.id) === last);
}

/** 下一轮的轮次（取消的轮次也占编号） */
export function nextReviewRound(tasks: readonly Pick<TaskFile, 'id'>[], taskId: string): number {
  const rounds = tasks.filter((t) => t.id === `${taskId}.rv` || t.id.startsWith(`${taskId}.rv-`) || t.id.startsWith(`${taskId}.rv.`)).map((t) => reviewRoundOf(t.id));
  return Math.max(0, ...rounds) + 1;
}

/** 下一轮整份审查的编号：T-003.rv → T-003.rv-2 → T-003.rv-3 */
export const nextReviewId = (tasks: readonly Pick<TaskFile, 'id'>[], taskId: string): string => reviewIdOf(taskId, nextReviewRound(tasks, taskId));

// —— 页面任务按页拆分审查 ——

/** 公共部分（[shared] 与没标记的 commit）的审查在 page 字段上的标记 */
export const SHARED_PART = '[shared]';

export interface TaskCommit { sha: string; subject: string }
export interface PageSplit {
  /** 每页的 commit（按 pages 的顺序，commit 按提交顺序） */
  pages: { page: string; commits: TaskCommit[] }[];
  /** [shared]、没有标记、标记了不在 pages 里的页面的 commit */
  shared: TaskCommit[];
  /** 标记了不在 pages 里的页面 id 的 commit（当作没有标记，提醒） */
  stray: { commit: TaskCommit; page: string }[];
  /** 找不到自己的 [page:<id>] commit 的页面：有任何一页时整批退回一次审查 */
  missing: string[];
}

/** 按提交说明开头的 [page:<id>] 与 [shared] 把页面任务的 commit 分到各页与公共部分（纯函数） */
export function splitPageCommits(commits: readonly TaskCommit[], pages: readonly string[]): PageSplit {
  const byPage = new Map(pages.map((p) => [p, [] as TaskCommit[]]));
  const shared: TaskCommit[] = [];
  const stray: PageSplit['stray'] = [];
  for (const c of commits) {
    const id = /^\s*\[page:\s*([^\]]*?)\s*\]/i.exec(c.subject)?.[1];
    if (id && byPage.has(id)) byPage.get(id)!.push(c);
    else {
      if (id) stray.push({ commit: c, page: id });
      shared.push(c);
    }
  }
  return { pages: pages.map((page) => ({ page, commits: byPage.get(page)! })), shared, stray, missing: pages.filter((p) => !byPage.get(p)!.length) };
}

// —— 10.2 输入：diff ——

/** 去掉 tests/acceptance/** 的文件段（任务不写自己的验收测试时，审查不看这部分） */
export function stripAcceptanceDiff(diff: string): string {
  if (!diff) return '';
  const sections = diff.split(/^(?=diff --git )/m);
  return sections.filter((s) => {
    const m = /^diff --git a\/(.+?) b\//.exec(s);
    return !(m && m[1]!.startsWith('tests/acceptance/'));
  }).join('');
}

/** 超过上限时在行边界截断并注明（reviewer 需要看全文时自己读文件） */
export function truncateDiff(diff: string, max = REVIEW_DIFF_MAX): { text: string; truncated: boolean } {
  if (diff.length <= max) return { text: diff, truncated: false };
  const cut = diff.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  const kept = nl > max / 2 ? cut.slice(0, nl) : cut;
  return { text: `${kept}\n…（diff 共 ${diff.length} 字，已截断到前 ${kept.length} 字；后面的改动请直接读文件）`, truncated: true };
}

/** 这个 diff 是否追加了契约（docs/contracts/** 有改动的文件） */
export const touchesContracts = (files: readonly string[]): boolean => files.some((f) => f.startsWith('docs/contracts/'));

// —— 10.2 输入：契约片段 ——

const baseNoExt = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');

/** 要给 reviewer 的契约文件：diff 里改到的在前，然后是本模块的契约文件（文件名与模块名相同，如 paths/<module>.yaml、modules/<module>.md） */
export function contractFilesFor(module: string | undefined, all: readonly string[], touched: readonly string[]): string[] {
  const contracts = all.filter((f) => f.startsWith('docs/contracts/'));
  const own = module ? contracts.filter((f) => baseNoExt(f) === module) : [];
  return [...new Set([...touched.filter((f) => f.startsWith('docs/contracts/') && contracts.includes(f)), ...own])];
}

/** 按总长上限收集契约片段；放不下的文件整份省略并列出名字 */
export function fitSnippets(files: readonly { path: string; content: string }[], max = CONTRACT_SNIPPET_MAX): { shown: { path: string; content: string }[]; omitted: string[] } {
  const shown: { path: string; content: string }[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    const room = max - used;
    if (room <= 200) { omitted.push(f.path); continue; }
    if (f.content.length <= room) { shown.push(f); used += f.content.length; continue; }
    shown.push({ path: f.path, content: `${f.content.slice(0, room)}\n…（已截断）` });
    used = max;
  }
  return { shown, omitted };
}

export const OPENAPI_PATH = 'docs/contracts/openapi.yaml';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const nameKey = (s: string) => s.toLowerCase().replace(/[-_]/g, '');

/**
 * openapi.yaml 里这个 domain 负责的接口（纯函数），给后端 domain 任务的审查材料用。契约没有固定的 domain 标记，任一条命中就算：
 * tags 或 x-domain 等于 domain 名；x-req 与本 domain 的需求有交集；路径里有一段是 domain 名（或加 s、es 的复数）。
 * 取到的接口按原结构写回 yaml（只含 paths，引用的 components 不展开）；解析失败或一个都没取到时返回 null。
 */
export function domainApiSection(text: string, domain: string, reqs: readonly string[] = []): string | null {
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return null; }
  const paths = (doc as { paths?: unknown } | null)?.paths;
  if (!paths || typeof paths !== 'object') return null;
  const d = nameKey(domain);
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(String);
  const segHit = (p: string) => p.split('/').some((seg) => [d, `${d}s`, `${d}es`].includes(nameKey(seg)));
  const out: Record<string, Record<string, unknown>> = {};
  for (const [p, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue;
    const entries = Object.entries(item as Record<string, unknown>);
    // 拆到 paths/<domain>.yaml 的路径只有 $ref：只能按路径判断
    const ops = entries.filter(([m, op]) => HTTP_METHODS.includes(m) && op && typeof op === 'object').filter(([, op]) => {
      const o = op as Record<string, unknown>;
      return [...list(o['tags']), ...list(o['x-domain'])].some((t) => nameKey(t) === d) || list(o['x-req']).some((r) => reqs.includes(r)) || segHit(p);
    });
    if (ops.length) out[p] = Object.fromEntries(ops);
    else if (!entries.some(([m]) => HTTP_METHODS.includes(m)) && segHit(p)) out[p] = item as Record<string, unknown>;
  }
  return Object.keys(out).length ? stringifyYaml({ paths: out }).trim() : null;
}

/** 后端 domain 任务审查材料里的契约片段：本 domain 的接口；openapi.yaml 不存在时不给，取不到时提示自己读（纯函数） */
export function domainApiSnippet(openapi: string, domain: string, ac: readonly string[]): { path: string; content: string }[] {
  if (!openapi) return [];
  const reqs = [...new Set(ac.map((a) => a.split('.')[0]!))];
  return [{ path: `${OPENAPI_PATH} 里 domain「${domain}」负责的接口`, content: domainApiSection(openapi, domain, reqs) ?? `（没找到本 domain 的接口，自己读 ${OPENAPI_PATH}）` }];
}

// —— 10.2 输入：任务说明 ——

export interface ReviewBriefInput {
  taskId: string;
  title: string;
  /** 这一轮的审查 task 编号 */
  reviewId: string;
  /** AC 编号 → 原文（PRD 里找不到的编号没有原文） */
  acIds: readonly string[];
  acTexts: Record<string, string>;
  contracts: { shown: { path: string; content: string }[]; omitted: string[] };
  deviations: readonly string[];
  /** 比较范围：<from>..<to>（第一轮是任务基线到提交，之后是上一轮审查之后的增量） */
  range: { from: string; to: string };
  diff: { text: string; truncated: boolean };
  /** 上一轮没有解决的 must；非空表示这是确认轮 */
  priorMust: readonly ReviewFinding[];
  /** 审查者要运行的本 task 自己的测试；不给表示不要求运行（阶段审查等） */
  tests?: ReviewTestPlan;
  /** worker 自己写的验收测试的 AC 覆盖扫描；不给表示验收测试不是 worker 写的 */
  acceptance?: AcceptanceAudit;
  /** diff 里是否含 tests/acceptance/**（worker 自己写验收测试时含，审查者要读） */
  withAcceptance?: boolean;
  /** diff 里落在其他 task 负责范围（writes）内的文件 */
  othersFiles?: readonly { file: string; owners: readonly string[] }[];
  /** plan.md 的公共文件里，改动不只是追加的文件 */
  sharedEdits?: readonly string[];
  /** 前端页面任务：这次对照的页面（按页审查时一页，退回整批审查时是全部） */
  pages?: readonly PageMaterial[];
  /** 页面任务按页拆开审查时，这个审查管哪一部分 */
  part?: ReviewPart;
  /** 这一轮的测试由另一个审查任务运行（按页审查时只让一个审查者运行，避免在同一个工作区里同时跑同一组测试） */
  testsBy?: string;
}

/** 一页的审查材料：原型文件路径（PRD 页面表）、docs/contracts/page-api.md 里这一页的部分（找不到时为 null）、对应需求的 AC 原文 */
export interface PageMaterial { id: string; prototype: string | null; api: string | null; acs: readonly { id: string; text: string | null }[] }

export type ReviewPart =
  | { kind: 'page'; page: string; pages: readonly string[] }
  | { kind: 'shared'; pages: readonly string[]; design: readonly string[]; stray: readonly string[] }
  | { kind: 'fallback'; missing: readonly string[] };

export const PAGE_API_PATH = 'docs/contracts/page-api.md';
export const PAGE_API_MAX = 6_000;

/**
 * page-api.md 里这一页的部分（纯函数）：标题里含页面 id 的小节（到下一个同级或更高级的标题为止）；
 * 没有这样的标题时取含页面 id 的行；都没有时返回 null。
 */
export function pageApiSection(md: string, page: string): string | null {
  const esc = page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const has = new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`, 'i');
  const lines = md.split('\n');
  const level = (l: string) => /^(#{1,6})\s/.exec(l)?.[1]!.length ?? 0;
  const start = lines.findIndex((l) => level(l) > 0 && has.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !(level(lines[end]!) > 0 && level(lines[end]!) <= level(lines[start]!))) end++;
    return lines.slice(start, end).join('\n').trim();
  }
  const hits = lines.filter((l) => has.test(l));
  return hits.length ? hits.join('\n') : null;
}

/** 前端页面任务的审查材料：对照原型看页面，对照 page-api.md 看接口，对照这一页的 AC 看功能 */
function pageSection(p: PageMaterial): string {
  const api = p.api === null ? `（${PAGE_API_PATH} 里没找到这一页的部分，自己读整个文件）`
    : p.api.length > PAGE_API_MAX ? `${fence(p.api.slice(0, PAGE_API_MAX))}\n（已截断，完整内容见 ${PAGE_API_PATH}）` : fence(p.api);
  return [
    `## 页面「${p.id}」的审查材料`,
    `原型：${p.prototype ?? '（PRD 的页面表里找不到这个页面）'}。打开原型文件，对照页面结构、字段、交互，以及加载、空、错误、无权限四种状态。`,
    `${PAGE_API_PATH} 里这一页的部分（核对页面调用的接口、参数、字段是否一致）：\n${api}`,
    ...(p.acs.length ? [`这一页对应需求的 AC（对照用：页面是否满足它们；页面任务不按「每条 AC 都要有测试」审）：\n${p.acs.map((a) => `- ${a.id}：${a.text ?? '（PRD 里找不到原文）'}`).join('\n')}`] : []),
  ].join('\n\n');
}

/** 页面任务按页拆开审查时，告诉审查者只管哪一部分 */
function partSection(part: ReviewPart): string {
  if (part.kind === 'fallback') {
    return `## 提醒：commit 没有按约定标记，退回整批审查\n这些页面找不到说明以 \`[page:<页面 id>]\` 开头的 commit：${part.missing.join('、')}。程序拆不开按页的审查，这次对整批的 diff 做一次审查：按下面的页面逐页对照原型与 page-api.md，公共组件与样式也一起看。`;
  }
  const intro = `这个页面任务一次做完了本批的 ${part.pages.length} 页（${part.pages.join('、')}），每页一个 commit；程序按提交说明的 \`[page:<id>]\`、\`[shared]\` 把审查拆开、并行进行。`;
  if (part.kind === 'page') {
    return `## 这次只审页面「${part.page}」\n${intro}下面的 diff 只含 \`[page:${part.page}]\` 的 commit（按提交顺序逐个列出，同一个文件可能出现在几个 commit 里，以最后的为准）。别的页面与公共部分由别的审查者审，不要对它们提问题，除非这一页的改动破坏了它们。`;
  }
  return [
    `## 这次只审公共部分\n${intro}下面的 diff 是 \`[shared]\` 与没有标记的 commit：公共组件、样式、路由与菜单，以及提交时程序自动提交的改动。看公共组件与样式是否和 DESIGN.md、theme.css 一致（docs/prototype/ 下是用户给的原件；产品里的副本可以在原件上补充，不能和原件冲突），已有页面的用法有没有被破坏；各页对照原型的检查由别的审查者做。`,
    `DESIGN.md、theme.css：${part.design.length ? part.design.join('、') : '仓库里没有'}`,
    ...(part.stray.length ? [`这些 commit 标记的页面不在本任务的页面清单里，按公共部分审：${part.stray.join('、')}`] : []),
  ].join('\n\n');
}

/** 跨 task 的两类问题单个 diff 里看不出来，提醒审查者专门看一眼（stock run-02：采购、销售各自留了一份 changeStock 替身；T-013 给商品页加导出按钮让整页打不开） */
function crossTaskSection(i: ReviewBriefInput): string[] {
  const out: string[] = [];
  if (i.sharedEdits?.length) out.push(`## 公共文件的已有内容被修改\n${i.sharedEdits.map((f) => `- ${f}`).join('\n')}\n这些是 docs/plan.md 登记的公共文件，并行的任务都会往里追加；本 task 改了或删了其中已有的内容（不只是追加）。看一眼修改是否必要、有没有破坏别的任务的用法。`);
  if (i.othersFiles?.length) out.push(`## 改了其他 task 负责的文件\n${i.othersFiles.map((f) => `- ${f.file}（${f.owners.join('、')}）`).join('\n')}\n这些文件原来的功能要照常可用：看改动有没有破坏它们（页面能不能打开、原来的按钮和接口是否还在），需要时运行相关的测试。`);
  return out;
}

const FENCE = '`'.repeat(3);
const fence = (s: string, lang = '') => `${FENCE}${lang}\n${s.replaceAll(FENCE, "'''")}\n${FENCE}`;

export function formatMust(m: ReviewFinding): string {
  return `- ${m.id}　出处：${m.basis}\n  位置：${m.files.join('、')}${m.location ? `（${m.location}）` : ''}\n  问题：${m.problem}\n  期望：${m.expected}`;
}

/** 任务说明里“先运行这些测试”一节：失败即 must，出处写 defect: */
function testsSection(tests: ReviewTestPlan, confirm: boolean): string {
  const cmds = tests.run.length
    ? tests.run.map((c) => `- ${c.name}：\`${c.shell}\``).join('\n')
    : '（本 task 没有需要运行的测试）';
  const skipped = tests.skipped.length ? `\n\n未运行：\n${tests.skipped.map((s) => `- ${s}`).join('\n')}` : '';
  const how = confirm
    ? '确认轮也先运行这些命令。测试仍失败，或者新失败：把与失败相关的条目（找不到相关条目就用第一条）标 resolved=false，note 里写命令与失败摘要。'
    : '先运行这些命令再读 diff。测试失败是阻塞问题：提交 must，basis 写 `defect:<命令> 失败：<失败的用例与原因>`，file 写出错的源文件，expected 写“该命令通过”。区分环境问题（依赖缺失、端口被占用等）与代码问题，环境问题用 forge_block 说明，不要当成代码缺陷。';
  const head = !tests.full ? '## 先运行本 task 自己的测试（全量测试与全部验收测试在阶段门禁）'
    : tests.run.length ? '## 先在架构师的分支上运行全量测试与验收测试（S0 的门禁不跑测试，只在这里跑）' : '## 测试';
  return `${head}\n${cmds}${skipped}\n\n${how}只运行上面列出的命令，不要运行别的测试命令。`;
}

/** 验收测试审查一节：程序算出的 AC 覆盖 + 要核对的三件事 */
function acceptanceSection(a: AcceptanceAudit): string {
  const rows = a.rows.map((r) => `- ${r.ac}：${r.files.length ? r.files.join('、') : '**没有带该编号的测试**'}`).join('\n');
  return [
    '## 审查本 task 的验收测试（worker 自己写的；diff 里含 tests/acceptance/**）',
    `程序扫描的 AC 覆盖（测试名里带 [REQ-xxx.ACn] 的文件）：\n${rows}`,
    a.missing.length ? `**以下 AC 没有测试：${a.missing.join('、')}。每条都是 must，basis 写 \`ac:<编号>\`，expected 写“补上带该编号的测试”。**` : '每条 AC 都有测试。',
    '再逐条核对（技能 acceptance-tests）：(1) 测试是否真的走了 AC 的 Given/When/Then，并且从公开入口（HTTP 接口、页面、跨模块函数）验证，不直接调内部函数或查数据库；(2) 断言有没有被弱化（只查状态码、断言过宽、什么都没断言、被跳过或删除的用例）；(3) 有没有依赖实现细节、断言了规格没规定的东西。缺失或形同虚设的测试是 must，basis 写对应的 `ac:<编号>`；写法上的小问题是 suggest。',
  ].join('\n\n');
}

/** reviewer 的任务说明（写进 .rv 的 handoff）；第一轮给完整输入，确认轮只给上一轮的 must 清单与增量 diff */
export function buildReviewBrief(i: ReviewBriefInput): string {
  const confirm = i.priorMust.length > 0;
  const diffSection = [
    `## ${confirm ? '这一轮的增量 diff' : 'diff'}（${i.range.from.slice(0, 8)}..${i.range.to.slice(0, 8)}，${i.withAcceptance ? '含' : '不含'} tests/acceptance/**）`,
    i.diff.text.trim() ? fence(i.diff.text, 'diff') : '（没有改动）',
    ...(i.diff.truncated ? [`diff 已按 ${REVIEW_DIFF_MAX} 字截断；被截掉的文件请直接读（工作目录就是被审查任务的工作区，改动已在其中）。`] : ['需要更多上下文时可以直接读相关代码，不要通读整个仓库。']),
  ].join('\n\n');
  if (confirm) {
    return [
      `# 审查确认（第二轮及以后）：${i.taskId}「${i.title}」`,
      '这是确认轮。worker 已按上一轮的 must 清单修改。**只能核对下面这些编号是否已经解决，用 forge_review_confirm 逐条回答 `{id, resolved, note}`，必须覆盖全部编号。**',
      '不能提出新问题（forge_review_confirm 没有新增问题的字段），也不要重新审查上一轮已审过且没有改动的代码。清单之外的发现写进某条的 note，交给阶段验收。',
      `## 上一轮的问题清单\n${i.priorMust.map(formatMust).join('\n')}`,
      ...(i.tests ? [testsSection(i.tests, true)] : i.testsBy ? [`这一轮的测试由 ${i.testsBy} 运行，你不用运行测试。`] : []),
      diffSection,
    ].join('\n\n');
  }
  const ac = i.acIds.length ? i.acIds.map((id) => `- ${id}：${i.acTexts[id] ?? '（PRD 里找不到原文）'}`).join('\n') : '（无）';
  const contracts = i.contracts.shown.length
    ? [...i.contracts.shown.map((c) => `### ${c.path}\n${fence(c.content)}`), ...(i.contracts.omitted.length ? [`（因长度限制省略：${i.contracts.omitted.join('、')}，需要时自己读）`] : [])].join('\n\n')
    : '（没有相关的契约文件）';
  return [
    `# 审查：${i.taskId}「${i.title}」（${i.reviewId}）`,
    `这是第一轮审查。${i.testsBy ? `这一轮的测试由 ${i.testsBy} 运行，你不用运行测试：按角色提示的顺序检查` : '程序没有预先运行测试：先运行下面列出的、本 task 自己的测试，再按角色提示的顺序检查'}；最后调用 forge_review_report 一次提交全部问题。must 必须写出处（rule:/ac:/contract:/defect:），写不出出处的是 suggest。`,
    ...(i.part ? [partSection(i.part)] : []),
    `## 本 task 的验收标准（AC 原文）\n${ac}`,
    `## 相关契约\n${contracts}`,
    `## worker 声明的偏离（已声明并且合理的不算问题）\n${i.deviations.length ? i.deviations.map((d) => `- ${d}`).join('\n') : '（无）'}`,
    ...(i.pages ?? []).map(pageSection),
    ...crossTaskSection(i),
    `本 task 涉及的 rules/<layer>.md（每个文件末尾有审查清单）已在系统提示的规则部分。`,
    ...(i.tests ? [testsSection(i.tests, false)] : []),
    ...(i.acceptance ? [acceptanceSection(i.acceptance)] : []),
    diffSection,
  ].join('\n\n');
}

/** 把 must 清单写成给 worker 的返工说明（追加到原 task 的 handoff） */
export function mustHandoff(round: number, must: readonly ReviewFinding[], final: boolean): string {
  return [
    `## 审查意见（第 ${round} 轮）：必须修改 ${must.length} 条`,
    must.map(formatMust).join('\n'),
    final ? '审查轮数已用完，仍有以上问题未解决，任务已阻塞，先交给主会话决定。' : '逐条修改后重新 forge_submit。下一轮审查者只会核对这些编号是否已解决，不会提出新问题；认为某条不成立时在 forge_note 里写明理由。',
  ].join('\n\n');
}

/** suggestions.md 中的一条（带 task 与 R 编号，作为去重标记） */
export function suggestionLine(reviewId: string, taskId: string, s: ReviewFinding): string {
  return `- [${reviewId} ${s.id}] ${taskId}：${s.problem}（出处：${s.basis}；${s.files.join('、')}${s.location ? ` ${s.location}` : ''}）→ ${s.expected}`;
}
