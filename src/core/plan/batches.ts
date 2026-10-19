// docs/plan.md 的「程序读取的部分」：批次、后端 domain、前端页面顺序、公共文件。解析、校验与派生任务都是纯函数。
// 校验只拦调度做不下去的情况（批次、domain 或页面 id 重名、after 指向不存在或更晚的 domain、after 成环、空批次），其余只提醒。
import { parse as parseYaml } from 'yaml';
import type { FlowFile, TaskFile } from '../state/schemas.ts';
import type { TaskInput } from '../state/state-store.ts';
import { findCycle } from '../state/dag.ts';
import { ownAcceptanceGlob } from '../state/paths.ts';
import { closesFence, fenceOpen, pageOf, type Prd } from '../spec/prd.ts';

export const PLAN_MD = 'docs/plan.md';
export const PLAN_SECTION = '程序读取的部分';
/** 架构阶段提交时必须存在的文件 */
export const ARCH_REQUIRED_FILES = ['AGENTS.md', 'docs/arch/overview.md', 'docs/arch/domains.md', 'docs/contracts/openapi.yaml', 'docs/contracts/page-api.md', 'commands.yaml', PLAN_MD] as const;
/** 架构阶段的 task 额外可写的验收目录与项目规则 rules/** */
export const S0_EXTRA_WRITES = ['tests/acceptance/_support/**', 'tests/acceptance/S0-smoke/**', 'rules/**'] as const;

/** reqs：这个 domain 负责的需求，任务的 AC 由它展开（不写时任务没有 AC 清单） */
export interface BackendDomain { domain: string; after: string[]; paths: string[]; reqs: string[] }
export interface Batch { id: string; title: string; reqs: string[]; backend: BackendDomain[]; frontend: string[] }
export interface BatchPlan { max_parallel_backend?: number; batches: Batch[]; shared: string[] }
type PlanStage = NonNullable<FlowFile['s_stages']>[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** YAML 把 1、true 读成数字、布尔值：错误里写明这一项应是字符串 */
const quoteHint = (v: unknown): string => {
  const bad = (Array.isArray(v) ? v : [v]).find((x) => typeof x === 'number' || typeof x === 'boolean');
  return bad === undefined ? '' : `：${String(bad)} 应是字符串，写成 "${String(bad)}"`;
};
const strings = (v: unknown): string[] | null => v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => (x as string).trim()) : null;

/**
 * 拆成说明部分（给人读）与「## 程序读取的部分」里的 yaml 代码块：优先取标了 yaml / yml 的块，没有时取第一个代码块；
 * 没有这一节或没有代码块时 yaml 为 null
 */
export function splitPlan(md: string): { prose: string; yaml: string | null } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s*(?:[\\d.、]+\\s*)?${PLAN_SECTION}\\s*$`).test(l.trim()));
  if (start < 0) return { prose: md.trim(), yaml: null };
  const prose = lines.slice(0, start).join('\n').trim();
  const blocks: { info: string; body: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const open = fenceOpen(lines[i]!);
    if (!open) continue;
    const close = lines.findIndex((l, j) => j > i && closesFence(l, open));
    blocks.push({ info: open.info.split(/\s/)[0]!.toLowerCase(), body: lines.slice(i + 1, close < 0 ? undefined : close).join('\n') });
    if (close < 0) break;
    i = close;
  }
  const block = blocks.find((b) => b.info === 'yaml' || b.info === 'yml') ?? blocks[0];
  return { prose, yaml: block ? block.body : null };
}

/** 「风险与假设」一节（不含标题）；没有时为空 */
export function risksSection(prose: string): string {
  const lines = prose.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s*(?:[\d.、]+\s*)?风险/.test(l.trim()));
  if (start < 0) return '';
  const level = lines[start]!.trim().match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** 解析 yaml 区块的形状：没见过的字段忽略，列表字段可以不写 */
export function parseBatchPlan(md: string): { plan: BatchPlan | null; errors: string[]; warnings: string[] } {
  const { yaml } = splitPlan(md);
  const fail = (e: string) => ({ plan: null, errors: [e], warnings: [] });
  if (yaml === null) return fail(`${PLAN_MD} 缺少「## ${PLAN_SECTION}」一节或其中的 yaml 代码块`);
  let raw: unknown;
  try { raw = parseYaml(yaml); } catch (e) { return fail(`${PLAN_MD} 的 yaml 区块不是合法的 YAML：${(e as Error).message.split('\n')[0]}`); }
  if (!isObj(raw)) return fail(`${PLAN_MD} 的 yaml 区块应是一个映射（max_parallel_backend、batches、shared）`);
  const errors: string[] = [];
  if (!Array.isArray(raw['batches']) || !raw['batches'].length) return fail(`${PLAN_MD}：batches 至少要有一个批次`);
  const batches: Batch[] = raw['batches'].map((b, i): Batch => {
    const at = `batches[${i}]`;
    if (!isObj(b)) { errors.push(`${at} 应是一个映射（id、title、reqs、backend、frontend）`); return { id: '', title: '', reqs: [], backend: [], frontend: [] }; }
    const id = typeof b['id'] === 'string' && b['id'].trim() ? b['id'].trim() : '';
    if (!id) errors.push(quoteHint(b['id']) ? `${at}.id${quoteHint(b['id'])}` : `${at} 缺少 id`);
    const reqs = strings(b['reqs']);
    if (!reqs) errors.push(`${at}.reqs 应是需求编号的列表${quoteHint(b['reqs'])}`);
    const frontend = strings(b['frontend']);
    if (!frontend) errors.push(`${at}.frontend 应是页面 id 的列表${quoteHint(b['frontend'])}`);
    const backend: BackendDomain[] = [];
    if (b['backend'] !== undefined && b['backend'] !== null && !Array.isArray(b['backend'])) errors.push(`${at}.backend 应是列表`);
    else for (const [j, d] of ((b['backend'] as unknown[] | undefined) ?? []).entries()) {
      const name = typeof d === 'string' ? d.trim() : isObj(d) && typeof d['domain'] === 'string' ? d['domain'].trim() : '';
      if (!name) {
        const hint = quoteHint(isObj(d) ? d['domain'] : d);
        errors.push(hint ? `${at}.backend[${j}].domain${hint}` : `${at}.backend[${j}] 缺少 domain`);
        continue;
      }
      const after = isObj(d) ? strings(d['after']) : [];
      const paths = isObj(d) ? strings(d['paths']) : [];
      const dreqs = isObj(d) ? strings(d['reqs']) : [];
      if (!after) errors.push(`${at}.backend[${j}].after 应是 domain 名的列表${quoteHint(isObj(d) ? d['after'] : undefined)}`);
      if (!paths) errors.push(`${at}.backend[${j}].paths 应是路径的列表`);
      if (!dreqs) errors.push(`${at}.backend[${j}].reqs 应是需求编号的列表${quoteHint(isObj(d) ? d['reqs'] : undefined)}`);
      backend.push({ domain: name, after: after ?? [], paths: paths ?? [], reqs: dreqs ?? [] });
    }
    return { id, title: typeof b['title'] === 'string' ? b['title'].trim() : '', reqs: reqs ?? [], backend, frontend: frontend ?? [] };
  });
  const shared = strings(raw['shared']);
  if (!shared) errors.push('shared 应是路径的列表');
  const mpb = raw['max_parallel_backend'];
  const valid = Number.isInteger(mpb) && (mpb as number) > 0;
  const warnings = mpb !== undefined && mpb !== null && !valid ? ['max_parallel_backend 应是正整数，已忽略'] : [];
  const plan: BatchPlan = { batches, shared: shared ?? [], ...(valid ? { max_parallel_backend: mpb as number } : {}) };
  return errors.length ? { plan: null, errors, warnings } : { plan, errors: [], warnings };
}

/** 用户与鉴权的真实实现所在的 domain：S0 只定鉴权接口与开发、测试用的桩 */
export const IDENTITY = 'identity';

/** 校验：errors 是调度做不下去的情况，warnings 只提醒 */
export function checkBatchPlan(plan: BatchPlan, prd: Prd): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const batchOf = new Map<string, number>();
  const ids = new Set<string>();
  // 同一个页面出现两次会生成两个任务去做同一页
  const pageBatch = new Map<string, string>();
  plan.batches.forEach((b, i) => {
    if (ids.has(b.id)) errors.push(`批次 id ${b.id} 重复`);
    ids.add(b.id);
    for (const p of b.frontend) {
      const prev = pageBatch.get(p);
      if (prev === undefined) pageBatch.set(p, b.id);
      else errors.push(prev === b.id ? `页面 ${p} 在批次 ${b.id} 里出现了两次` : `页面 ${p} 重复（批次 ${prev} 与 ${b.id}）`);
    }
    if (!b.backend.length && !b.frontend.length) errors.push(`批次 ${b.id} 既没有 backend 也没有 frontend`);
    for (const d of b.backend) {
      if (batchOf.has(d.domain)) errors.push(`domain ${d.domain} 重名（批次 ${plan.batches[batchOf.get(d.domain)!]!.id} 与 ${b.id}）`);
      else batchOf.set(d.domain, i);
    }
  });
  const edges = new Map<string, string[]>();
  plan.batches.forEach((b, i) => {
    for (const d of b.backend) {
      for (const a of d.after) {
        const at = batchOf.get(a);
        if (at === undefined) errors.push(`domain ${d.domain} 的 after 指向不存在的 domain ${a}`);
        else if (at > i) errors.push(`domain ${d.domain}（批次 ${b.id}）的 after 指向更晚批次 ${plan.batches[at]!.id} 的 domain ${a}`);
      }
      if (!edges.has(d.domain)) edges.set(d.domain, d.after.filter((a) => batchOf.has(a)));
    }
  });
  const cycle = findCycle([...edges].map(([id, after]) => ({ id, depends_on: after.map((task) => ({ task, type: 'hard' as const })) })));
  if (cycle) errors.push(`domain 的 after 形成环：${cycle.join(' → ')}`);
  const planned = new Set(plan.batches.flatMap((b) => b.reqs));
  const known = new Set(prd.reqs.map((r) => r.id));
  // 漏掉的需求不会生成任务（stock rework-02：plan.md 正文把 REQ-015 归给 report，yaml 漏了；提醒了，架构师与两轮审查都没改）
  const missing = prd.reqs.filter((r) => !planned.has(r.id)).map((r) => r.id);
  if (missing.length) errors.push(`PRD 里这些需求没有出现在任何批次：${missing.join('、')}。每条需求都要放进一个批次的 reqs；要不要做由用户决定，觉得不该做的先问用户`);
  const unknownReqs = [...new Set([...planned, ...plan.batches.flatMap((b) => b.backend.flatMap((d) => d.reqs))])].filter((r) => !known.has(r));
  if (unknownReqs.length && prd.reqs.length) warnings.push(`批次里这些需求编号在 PRD 里找不到：${unknownReqs.join('、')}`);
  const unknownPages = plan.batches.flatMap((b) => b.frontend).filter((p) => !pageOf(prd, p));
  if (unknownPages.length) warnings.push(`这些页面 id 在 PRD 的页面表里找不到对应项：${[...new Set(unknownPages)].join('、')}`);
  // 别的 domain 只依赖 S0 定的鉴权接口、开发时用桩，不等 identity（stock run-01：登录 → 分类 → 商品三环依赖把 4 个能并行的任务拖成串行）
  const waits = plan.batches.flatMap((b) => b.backend).filter((d) => d.after.includes(IDENTITY)).map((d) => d.domain);
  if (waits.length) warnings.push(`这些 domain 写了 after: [${IDENTITY}]：${waits.join('、')}。别的 domain 只依赖 S0 定的鉴权接口、开发时用桩，可以和 ${IDENTITY} 并行`);
  const at = batchOf.get(IDENTITY);
  if (at !== undefined && at > 0) warnings.push(`${IDENTITY} 不在第 1 批（在 ${plan.batches[at]!.id}）：之前批次的门禁与浏览器验收只能在鉴权桩下跑`);
  return { errors, warnings };
}

/** 页面任务说明里的一页：原型文件、对应需求与 page-api.md 里的位置 */
function pageBrief(prd: Prd, id: string, n: number): string {
  const p = pageOf(prd, id);
  const api = `接口见 docs/contracts/page-api.md 里 ${id} 这一页`;
  return p ? `${n}. ${id}：原型 ${p.file || '（页面表里没写）'}；对应需求 ${p.reqs.join('、') || '（没写）'}；${api}` : `${n}. ${id}：PRD 的页面表里找不到这个页面；${api}`;
}

/**
 * 按计划生成批次阶段 S1…Sn 与任务（编号从 firstId 起）：每个 domain 一个后端任务（after 在本批的为硬依赖，前面批次的已完成）；
 * 第一个有页面的批次先做前端基础（单独审查、合并，页面的写法主要由它决定）；每批的页面是一个页面任务（pages 按 plan.md 的顺序），
 * 前端在一个任务里连续做完、每页一个 commit，审查按页拆开；有页面的批次最后接入真实接口（依赖本批的页面任务与后端，不单独审查）。
 * 每个前端任务接着计划顺序里上一个前端任务的会话做（跨批也接，会话太大时程序开新会话）。
 */
export function deriveBatchTasks(plan: BatchPlan, prd: Prd, firstId: number, opts: { verify?: string[] } = {}): { stages: PlanStage[]; tasks: TaskInput[] } {
  let n = firstId;
  const nextId = () => `T-${String(n++).padStart(3, '0')}`;
  const stages: PlanStage[] = [];
  const tasks: TaskInput[] = [];
  let foundation: string | null = null;
  let prevFront: string | null = null;
  const hard = (task: string, reason: string): TaskFile['depends_on'][number] => ({ task, type: 'hard', reason });
  plan.batches.forEach((b, i) => {
    const stage = `S${i + 1}`;
    stages.push({ id: stage, goal: b.title ? `${b.id} ${b.title}` : b.id, exit: [...b.reqs] });
    const reqs = b.reqs.length ? `本批需求：${b.reqs.join('、')}（验收标准见 docs/PRD.md）。` : '';
    // 角色 backend / frontend 决定调度池与角色提示；layers 决定注入哪份 rules/<layer>.md
    const mk = (layer: 'backend' | 'frontend', title: string, description: string, deps: TaskFile['depends_on'], writes: string[], extra: Partial<TaskInput> = {}): TaskInput => {
      const id = nextId();
      return { id, stage, kind: 'impl', role: layer, title, description, scopes: ['code'], layers: [layer], depends_on: deps, inputs: [],
        writes: [...new Set([...writes, ownAcceptanceGlob(id)])], verify: [...(opts.verify ?? [])], ...(plan.shared.length ? { shared: [...plan.shared] } : {}), ...extra };
    };
    const domainTask = new Map<string, string>();
    const backend = b.backend.map((d) => {
      const deps = d.after.filter((a) => domainTask.has(a) || b.backend.some((x) => x.domain === a));
      return { d, deps };
    });
    // 本批内按 after 排好顺序再编号，依赖总是指向已编号的任务
    const ordered: typeof backend = [];
    const placed = new Set<string>();
    while (ordered.length < backend.length) {
      const next = backend.find((x) => !placed.has(x.d.domain) && x.deps.every((a) => placed.has(a)));
      if (!next) break;
      ordered.push(next);
      placed.add(next.d.domain);
    }
    for (const { d, deps } of ordered) {
      // 页面任务不分 AC：PRD 不区分页面 AC 与接口 AC，分给页面任务会让审查按接口 AC 要前端的测试
      const ac = d.reqs.flatMap((id) => prd.reqs.find((r) => r.id === id)?.acs.map((a) => `${id}.${a.id}`) ?? []);
      const own = d.reqs.length ? `本 domain 负责的需求：${d.reqs.join('、')}（AC 见「验收标准」）。` : '';
      const t = mk('backend', `后端 ${d.domain}`, `后端 domain「${d.domain}」的整条链路：领域模型、服务、仓储、数据访问、controller、DTO、本 domain 的迁移与测试。职责、表与对外接口见 docs/arch/domains.md，HTTP 接口严格按 docs/contracts/openapi.yaml。${own}${reqs}`,
        deps.map((a) => hard(domainTask.get(a)!, `需要 domain ${a}`)), d.paths, { domain: d.domain, ...(ac.length ? { ac } : {}) });
      domainTask.set(d.domain, t.id);
      tasks.push(t);
    }
    if (!b.frontend.length) return;
    const fork = () => (prevFront ? { fork_from_task: prevFront } : {});
    const firstPages = !foundation;
    if (firstPages) {
      const t = mk('frontend', '前端基础', `前端基础：把 docs/prototype/DESIGN.md 与 theme.css 拷到前端目录作为产品的 DESIGN.md、theme.css，照它们写公共组件与布局。${reqs}`, [], []);
      tasks.push(t);
      foundation = prevFront = t.id;
    }
    const pageList = b.frontend.map((p, k) => pageBrief(prd, p, k + 1)).join('\n');
    const pages = mk('frontend', `页面（${b.id}）`, `本批页面，按顺序一页一页做：\n${pageList}\n每页严格按原型实现页面结构与交互，以及加载、空、错误、无权限四种状态，对着 mock 开发。每做完一页提交一次 commit，说明以 \`[page:<页面 id>]\` 开头；公共组件与样式的改动单独提交，说明以 \`[shared]\` 开头。全部页面做完后 forge_submit 一次。${reqs}`,
      firstPages ? [hard(foundation!, '页面要在前端基础之上做')] : [], [], { pages: [...b.frontend], ...fork() });
    tasks.push(pages);
    prevFront = pages.id;
    const deps = [...domainTask.values(), pages.id].map((x) => hard(x, '接入真实接口要等本批的页面与后端都完成'));
    const integrate = mk('frontend', `接入真实接口（${b.id}）`, `把本批页面（${b.frontend.join('、')}）从 mock 切到真实接口，修好前端用错接口的地方，跑本批的验收测试。后端返回与 openapi.yaml 不一致时不改后端代码，写进 forge_submit 的 backend_issues 交给后端修。前端不能改契约；契约有问题向架构师提问。${reqs}`,
      deps, [], { review: 'skip', ...fork() });
    tasks.push(integrate);
    prevFront = integrate.id;
  });
  return { stages, tasks };
}
