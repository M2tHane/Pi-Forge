// 前端页面任务按页并行审查：一批 3 页一个任务、每页一个 [page:<id>] commit 加一个 [shared] commit →
// 3 个页面审查加 1 个公共部分审查并行 → 汇总 must 一次退回 → 第二轮只确认有 must 的页面 → 合并。没有按约定标记时退回整批一次审查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, type Project } from '../helpers/project.ts';
import { drive, engineEnv, writeFiles } from '../helpers/commands.ts';
import { mkTask } from '../helpers/tasks.ts';
import { ARCH_FILES } from '../helpers/arch.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { readReviewEvidence, REVIEW_INPUT, type ReviewInputFile } from '../../src/core/stage/review-flow.ts';

const PAGES = ['login', 'products', 'purchase-orders'];
const FILES = {
  ...Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => k.startsWith('docs/PRD') || k.startsWith('docs/prototype/'))),
  'docs/contracts/page-api.md': '# 页面与接口\n\n## login\n- POST /api/login\n\n## products\n- GET /api/products\n\n## purchase-orders\n- POST /api/purchase-orders\n',
  'src/web/DESIGN.md': '# 设计\n',
};
const pageTask = () => mkTask('T-001', { stage: 'S1', role: 'frontend', layers: ['frontend'], title: '页面（B1）', pages: PAGES, ac: [], writes: ['tests/acceptance/T-001/**'] });
const must = (file: string, problem: string) => ({ level: 'must' as const, basis: 'ac:REQ-001.AC1', files: [file], location: '', problem, expected: '照原型改' });

async function commit(a: FakeAgent, files: Record<string, string>, message: string): Promise<void> {
  await writeFiles(a, files);
  const r = await a.call('bash', { command: `git add -A && git commit -q -m '${message}'` });
  assert.ok(r.ok, r.text);
}

async function setup(): Promise<Project> {
  return setupProject({ stages: ['S1'], files: FILES, tasks: [pageTask()] });
}

test('页面任务：3 个页面审查加 1 个公共审查并行 → 汇总 must 一次退回 → 第二轮只确认有 must 的页面 → 合并', async () => {
  const p = await setup();
  const briefs: Record<string, string> = {};
  const handoffs: string[] = [];
  let running = 0;
  let peak = 0;
  const e = engineEnv(p, async (role, nth, a) => {
    await a.call('forge_claim');
    if (role === 'frontend') {
      if (nth === 1) {
        await commit(a, { 'src/web/components/button.ts': 'export const button = 1;\n' }, '[shared] 公共按钮');
        for (const page of PAGES) await commit(a, { [`src/web/pages/${page}.ts`]: `export const page = '${page}';\n` }, `[page:${page}] ${page} 页`);
      } else {
        handoffs.push(p.store.readHandoff(p.flowId, 'T-001'));
        await writeFiles(a, { 'src/web/pages/login.ts': "export const page = 'login'; // 已按原型改\n", 'src/web/pages/purchase-orders.ts': "export const page = 'purchase-orders'; // 已按原型改\n" });
      }
      await a.call('forge_note', { text: `第 ${nth} 次` });
      const r = await a.call('forge_submit', { summary: nth === 1 ? '本批 3 页' : '按审查意见改了 login 与 purchase-orders' });
      assert.ok(r.ok, r.text);
      return;
    }
    assert.equal(role, 'reviewer');
    const id = a.env.task;
    briefs[id] = a.spec.prompt;
    running++;
    peak = Math.max(peak, running);
    try {
      // 第一轮等 4 个审查者都开工（并行），最多等 3 秒
      for (const end = Date.now() + 3000; !id.includes('.rv-') && running < 4 && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
      const r = id === 'T-001.rv.1' ? await a.call('forge_review_report', { verdict: 'changes', issues: [must('src/web/pages/login.ts', '登录页缺错误状态')] })
        : id === 'T-001.rv.3' ? await a.call('forge_review_report', { verdict: 'changes', issues: [must('src/web/pages/purchase-orders.ts', '采购单缺空状态')] })
          : id.includes('.rv-2.') ? await a.call('forge_review_confirm', { items: [{ id: 'R-1', resolved: true, note: '已改' }] })
            : await a.call('forge_review_report', { verdict: 'pass', issues: [] });
      assert.ok(r.ok, r.text);
    } finally { running--; }
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    const t = p.store.readTask(p.flowId, 'T-001');
    assert.equal(t.status, 'done', `${t.blocked_reason ?? ''}${t.last_failure ?? ''}`);
    assert.equal(t.review_rounds, 1, '一轮里几个审查也只算一轮');

    // 第一轮：每页一个审查（序号是页面的位置）加公共部分（.rv.0）；第二轮只为有 must 的两页建确认审查
    const reviews = p.store.listTasks(p.flowId).filter((x) => x.kind === 'review').map((x) => [x.id, x.page, x.for_task, x.status]);
    assert.deepEqual(reviews, [
      ['T-001.rv-2.1', 'login', 'T-001', 'done'], ['T-001.rv-2.3', 'purchase-orders', 'T-001', 'done'],
      ['T-001.rv.0', '[shared]', 'T-001', 'done'], ['T-001.rv.1', 'login', 'T-001', 'done'], ['T-001.rv.2', 'products', 'T-001', 'done'], ['T-001.rv.3', 'purchase-orders', 'T-001', 'done'],
    ]);
    assert.equal(peak, 4, '第一轮 4 个审查在辅助池里并行');

    // 页面审查的材料：只有这一页的 commit、原型、page-api.md 里这一页、对应需求的 AC；测试只由公共部分的审查者运行
    const login = briefs['T-001.rv.1']!;
    assert.match(login, /## 这次只审页面「login」/);
    assert.match(login, /# commit [0-9a-f]{8} \[page:login\] login 页\ndiff --git a\/src\/web\/pages\/login\.ts/);
    assert.doesNotMatch(login, /products\.ts|button\.ts/);
    assert.match(login, /原型：docs\/prototype\/login\.html/);
    assert.match(login, /```\n## login\n- POST \/api\/login\n```/);
    assert.match(login, /- REQ-001\.AC1：Given 已注册 When 登录 Then 进入首页/);
    assert.match(login, /这一轮的测试由 T-001\.rv\.0 运行/);
    const shared = briefs['T-001.rv.0']!;
    assert.match(shared, /## 这次只审公共部分[\s\S]*DESIGN\.md、theme\.css：src\/web\/DESIGN\.md/);
    assert.match(shared, /\[shared\] 公共按钮\ndiff --git a\/src\/web\/components\/button\.ts/);
    assert.doesNotMatch(shared, /pages\/login\.ts/);
    assert.match(shared, /先运行本 task 自己的测试/);

    // 汇总一次退回：两页的 must 带上页面前缀，前端接着原会话一起改
    const backs = p.store.readEvents().filter((ev) => ev.task === 'T-001' && ev.trigger === 'review_changes');
    assert.equal(backs.length, 1);
    assert.match(handoffs[0]!, /审查意见（第 1 轮）：必须修改 2 条[\s\S]*login\/R-1[\s\S]*登录页缺错误状态[\s\S]*purchase-orders\/R-1[\s\S]*采购单缺空状态[\s\S]*按页审查/);
    assert.equal(e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === 'T-001').length, 2);

    // 第二轮只确认：各自上一轮的 must 清单与增量 diff
    const confirm = briefs['T-001.rv-2.1']!;
    assert.match(confirm, /确认轮/);
    assert.match(confirm, /R-1　出处：ac:REQ-001\.AC1[\s\S]*登录页缺错误状态/);
    assert.doesNotMatch(confirm, /采购单缺空状态/);
    assert.match(confirm, /已按原型改/);
    assert.equal(readReviewEvidence<ReviewInputFile>(p.store, p.flowId, 'T-001.rv-2.3', REVIEW_INPUT)!.prior_must[0]!.problem, '采购单缺空状态');

    const integ = p.store.readFlow(p.flowId).integration_branch;
    for (const page of PAGES) assert.match(p.git('show', `${integ}:src/web/pages/${page}.ts`), new RegExp(page));
  } finally { p.cleanup(); }
});

test('页面任务的 commit 没有按约定标记：退回整批一次审查，审查材料、给前端的 handoff 与事件里都提醒', async () => {
  const p = await setup();
  const briefs: Record<string, string> = {};
  const e = engineEnv(p, async (role, _nth, a) => {
    await a.call('forge_claim');
    if (role === 'frontend') {
      await commit(a, { 'src/web/pages/login.ts': '1\n' }, '[page:login] 登录页');
      await commit(a, { 'src/web/pages/reports.ts': '1\n' }, '[page:reports] 不在清单里的页面');
      await writeFiles(a, { 'src/web/pages/products.ts': '1\n', 'src/web/pages/purchase-orders.ts': '1\n' });
      await a.call('forge_note', { text: '完成' });
      const r = await a.call('forge_submit', { summary: '三页一起做完' });
      assert.ok(r.ok, r.text);
      return;
    }
    briefs[a.env.task] = a.spec.prompt;
    assert.ok((await a.call('forge_review_report', { verdict: 'pass', issues: [] })).ok);
  });
  try {
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.deepEqual(p.store.listTasks(p.flowId).filter((x) => x.kind === 'review').map((x) => [x.id, x.page ?? null]), [['T-001.rv', null]]);
    const brief = briefs['T-001.rv']!;
    assert.match(brief, /## 提醒：commit 没有按约定标记，退回整批审查\n这些页面找不到[^\n]*：products、purchase-orders/);
    for (const page of PAGES) assert.match(brief, new RegExp(`## 页面「${page}」的审查材料`));
    assert.match(brief, /diff --git a\/src\/web\/pages\/products\.ts/);
    assert.match(brief, /先运行本 task 自己的测试/);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /提醒：commit 没有按约定标记，退回整批审查。这些页面找不到[^\n]*products、purchase-orders/);
    const ev = p.store.readEvents().find((x) => x.task === 'T-001' && x.data?.['kind'] === 'page_commit_marks')!;
    assert.deepEqual([ev.data!['missing'], ev.data!['stray']], [['products', 'purchase-orders'], ['reports']]);
  } finally { p.cleanup(); }
});
