// docs/plan.md 的 yaml 区块：解析、校验、生成批次阶段与任务（纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBatchPlan, deriveBatchTasks, parseBatchPlan, risksSection, splitPlan } from '../../src/core/plan/batches.ts';
import { parsePrd } from '../../src/core/spec/prd.ts';
import { ARCH_PRD, PLAN_MD_TEXT } from '../helpers/arch.ts';

const prd = parsePrd(ARCH_PRD);
const planOf = (yaml: string) => parseBatchPlan(`# 计划\n\n## 程序读取的部分\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`);

test('splitPlan 与 risksSection：说明部分、yaml 区块、风险与假设', () => {
  const { prose, yaml } = splitPlan(PLAN_MD_TEXT);
  assert.match(prose, /^# 计划[\s\S]*价格按分存整数$/);
  assert.match(yaml!, /^max_parallel_backend: 2\nbatches:/);
  assert.equal(risksSection(prose), '- 采购单不设审批（PRD 没写）\n- 价格按分存整数');
  assert.deepEqual(splitPlan('# 没有程序读取的部分'), { prose: '# 没有程序读取的部分', yaml: null });
});

test('parseBatchPlan：字段与默认值；backend 可以只写 domain 名；形状不对是错误', () => {
  const ok = parseBatchPlan(PLAN_MD_TEXT);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.plan!.max_parallel_backend, 2);
  assert.deepEqual(ok.plan!.shared, ['src/shared/**']);
  assert.deepEqual(ok.plan!.batches[0]!.backend.map((d) => [d.domain, d.after, d.paths]), [['user', [], ['src/server/user/**']], ['inventory', ['catalog'], []], ['catalog', [], ['src/server/catalog/**']]]);
  assert.deepEqual(planOf('batches:\n  - id: B1\n    backend: [user]').plan!.batches[0], { id: 'B1', title: '', reqs: [], backend: [{ domain: 'user', after: [], paths: [], reqs: [] }], frontend: [] });
  assert.match(parseBatchPlan('# 计划').errors.join(), /缺少「## 程序读取的部分」/);
  assert.match(planOf('batches: [').errors.join(), /不是合法的 YAML/);
  assert.match(planOf('batches: []').errors.join(), /至少要有一个批次/);
  assert.deepEqual(planOf('batches:\n  - title: x\n    frontend: login\n    backend:\n      - { after: [a] }').errors, ['batches[0] 缺少 id', 'batches[0].frontend 应是页面 id 的列表', 'batches[0].backend[0] 缺少 domain']);
  assert.deepEqual(planOf('max_parallel_backend: 0\nbatches:\n  - id: B1\n    frontend: [a]').warnings, ['max_parallel_backend 应是正整数，已忽略']);
});

test('checkBatchPlan：只拦调度做不下去的（批次与 domain 重名、after 不存在、指向更晚批次、成环、空批次）', () => {
  const bad = planOf([
    'batches:',
    '  - id: B1',
    '    backend: [{ domain: a, after: [b] }, { domain: b, after: [a] }, { domain: c, after: [ghost] }, { domain: d, after: [e] }]',
    '  - id: B1',
    '    backend: [{ domain: a }]',
    '  - id: B2',
    '    backend: [{ domain: e }]',
    '  - id: B3',
  ].join('\n')).plan!;
  assert.deepEqual(checkBatchPlan(bad, parsePrd('')).errors, [
    '批次 id B1 重复',
    'domain a 重名（批次 B1 与 B1）',
    '批次 B3 既没有 backend 也没有 frontend',
    'domain c 的 after 指向不存在的 domain ghost',
    'domain d（批次 B1）的 after 指向更晚批次 B2 的 domain e',
    'domain 的 after 形成环：a → b → a',
  ]);
});

test('checkBatchPlan：没进批次的需求是错误；PRD 里没有的需求与页面只提醒', () => {
  const plan = planOf('batches:\n  - id: B1\n    reqs: [REQ-001, REQ-404]\n    frontend: [login, nope]').plan!;
  const r = checkBatchPlan(plan, prd);
  assert.deepEqual(r.errors, ['PRD 里这些需求没有出现在任何批次：REQ-002、REQ-003。每条需求都要放进一个批次的 reqs；要不要做由用户决定，觉得不该做的先问用户']);
  assert.deepEqual(r.warnings, [
    '批次里这些需求编号在 PRD 里找不到：REQ-404',
    '这些页面 id 在 PRD 的页面表里找不到对应项：nope',
  ]);
});

test('checkBatchPlan：别的 domain 写 after: [identity]、identity 不在第 1 批只提醒', () => {
  const plan = planOf('batches:\n  - id: B1\n    backend: [user]\n  - id: B2\n    backend: [identity, { domain: catalog, after: [identity] }]').plan!;
  assert.deepEqual(checkBatchPlan(plan, parsePrd('')).warnings, [
    '这些 domain 写了 after: [identity]：catalog。别的 domain 只依赖 S0 定的鉴权接口、开发时用桩，可以和 identity 并行',
    'identity 不在第 1 批（在 B2）：之前批次的门禁与浏览器验收只能在鉴权桩下跑',
  ]);
  assert.deepEqual(checkBatchPlan(planOf('batches:\n  - id: B1\n    backend: [identity, catalog]').plan!, parsePrd('')).warnings, []);
});

test('deriveBatchTasks：每批一个阶段；domain 任务按 after 排序与依赖；前端基础只在第一批；每批一个页面任务；接入真实接口依赖本批的页面任务与后端且不审查；前端任务跨批接着上一个前端任务的会话', () => {
  const plan = parseBatchPlan(PLAN_MD_TEXT).plan!;
  const { stages, tasks } = deriveBatchTasks(plan, prd, 2, { verify: ['test'] });
  assert.deepEqual(stages, [{ id: 'S1', goal: 'B1 基础资料', exit: ['REQ-001', 'REQ-002'] }, { id: 'S2', goal: 'B2 单据', exit: ['REQ-003'] }]);
  const row = (id: string) => {
    const t = tasks.find((x) => x.id === id)!;
    return [t.stage, t.title, t.depends_on.map((d) => d.task), t.fork_from_task ?? null, t.review ?? null];
  };
  assert.deepEqual(tasks.map((t) => t.id), ['T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008', 'T-009', 'T-010']);
  assert.deepEqual(row('T-002'), ['S1', '后端 user', [], null, null]);
  assert.deepEqual(row('T-003'), ['S1', '后端 catalog', [], null, null]);
  assert.deepEqual(row('T-004'), ['S1', '后端 inventory', ['T-003'], null, null]);
  assert.deepEqual(row('T-005'), ['S1', '前端基础', [], null, null]);
  assert.deepEqual(row('T-006'), ['S1', '页面（B1）', ['T-005'], 'T-005', null]);
  assert.deepEqual(row('T-007'), ['S1', '接入真实接口（B1）', ['T-002', 'T-003', 'T-004', 'T-006'], 'T-006', 'skip']);
  assert.deepEqual(row('T-008'), ['S2', '后端 purchase', [], null, null], '依赖前面批次的 domain 视为已满足');
  assert.deepEqual(row('T-009'), ['S2', '页面（B2）', [], 'T-007', null], '之后的批次没有前端依赖，接着上一批接入真实接口的会话');
  assert.deepEqual(row('T-010'), ['S2', '接入真实接口（B2）', ['T-008', 'T-009'], 'T-009', 'skip']);
  const user = tasks.find((t) => t.id === 'T-002')!;
  assert.deepEqual(user.writes, ['src/server/user/**', 'tests/acceptance/T-002/**']);
  assert.deepEqual(user.shared, ['src/shared/**']);
  assert.deepEqual(user.verify, ['test']);
  // 页面任务的说明逐页列出原型、对应需求与 page-api.md 的位置，并写明每页一个 commit 的标记
  const pages = tasks.find((t) => t.id === 'T-006')!;
  assert.match(pages.description!, /1\. login：原型 docs\/prototype\/login\.html；对应需求 REQ-001；接口见 docs\/contracts\/page-api\.md 里 login 这一页\n2\. products：原型 docs\/prototype\/products\.html/);
  assert.match(pages.description!, /\[page:<页面 id>\][\s\S]*\[shared\]/);
  assert.equal(pages.page, undefined);
  assert.ok(tasks.every((t) => t.kind === 'impl'));
  // 角色决定调度池：domain 任务是 backend（带 domain），前端基础、页面任务（带 pages）、接入真实接口是 frontend
  assert.deepEqual(tasks.map((t) => t.role), ['backend', 'backend', 'backend', 'frontend', 'frontend', 'frontend', 'backend', 'frontend', 'frontend']);
  assert.deepEqual(tasks.map((t) => t.layers![0]), tasks.map((t) => t.role));
  assert.deepEqual(tasks.map((t) => t.domain ?? t.pages ?? null), ['user', 'catalog', 'inventory', null, ['login', 'products'], null, 'purchase', ['purchase-orders'], null]);
});

test('domain 的 reqs：后端任务的 AC 由它展开；没写 reqs 的 domain 与页面任务没有 AC；PRD 里找不到的编号只提醒', () => {
  const r = planOf('batches:\n  - id: B1\n    reqs: [REQ-001, REQ-002]\n    backend:\n      - { domain: user, reqs: [REQ-001] }\n      - { domain: catalog }\n    frontend: [login]');
  assert.deepEqual(r.plan!.batches[0]!.backend.map((d) => [d.domain, d.reqs]), [['user', ['REQ-001']], ['catalog', []]]);
  assert.deepEqual(planOf('batches:\n  - id: B1\n    backend:\n      - { domain: user, reqs: REQ-001 }').errors, ['batches[0].backend[0].reqs 应是需求编号的列表']);
  const { tasks } = deriveBatchTasks(r.plan!, prd, 2);
  const user = tasks.find((t) => t.domain === 'user')!;
  assert.deepEqual(user.ac, ['REQ-001.AC1']);
  assert.match(user.description!, /本 domain 负责的需求：REQ-001（AC 见「验收标准」）。本批需求：REQ-001、REQ-002/);
  assert.equal(tasks.find((t) => t.domain === 'catalog')!.ac, undefined);
  assert.ok(tasks.filter((t) => t.role === 'frontend').every((t) => t.ac === undefined), '页面任务不分 AC');
  const ghost = planOf('batches:\n  - id: B1\n    reqs: [REQ-001]\n    backend:\n      - { domain: user, reqs: [REQ-009] }').plan!;
  assert.ok(checkBatchPlan(ghost, prd).warnings.includes('批次里这些需求编号在 PRD 里找不到：REQ-009'));
});

test('splitPlan：优先取标了 yaml / yml 的代码块，没有时取第一个；四个反引号的围栏不在内层三个反引号处截断', () => {
  const head = '# 计划\n\n## 程序读取的部分\n\n';
  assert.equal(splitPlan(`${head}\`\`\`text\n示意\n\`\`\`\n\n\`\`\`yml\nbatches: []\n\`\`\`\n`).yaml, 'batches: []');
  assert.equal(splitPlan(`${head}\`\`\`\nfirst: 1\n\`\`\`\n\`\`\`json\n{}\n\`\`\`\n`).yaml, 'first: 1');
  assert.equal(splitPlan(`${head}\`\`\`\`yaml\na: |\n  \`\`\`\n  x\n  \`\`\`\nb: 2\n\`\`\`\`\n`).yaml, 'a: |\n  ```\n  x\n  ```\nb: 2');
  assert.equal(splitPlan(`${head}没有代码块`).yaml, null);
});

test('checkBatchPlan：页面 id 在批次内或跨批次重复是错误', () => {
  const plan = planOf('batches:\n  - id: B1\n    frontend: [login, products, login]\n  - id: B2\n    frontend: [products]').plan!;
  assert.deepEqual(checkBatchPlan(plan, parsePrd('')).errors, ['页面 login 在批次 B1 里出现了两次', '页面 products 重复（批次 B1 与 B2）']);
});

test('parseBatchPlan：id、页面、domain、需求写成数字时提示应是字符串', () => {
  assert.deepEqual(planOf('batches:\n  - id: 1\n    reqs: [REQ-001, 2]\n    frontend: [login, 404]\n    backend:\n      - 7\n      - { domain: 8 }\n      - { domain: user, after: [true] }').errors, [
    'batches[0].id：1 应是字符串，写成 "1"',
    'batches[0].reqs 应是需求编号的列表：2 应是字符串，写成 "2"',
    'batches[0].frontend 应是页面 id 的列表：404 应是字符串，写成 "404"',
    'batches[0].backend[0].domain：7 应是字符串，写成 "7"',
    'batches[0].backend[1].domain：8 应是字符串，写成 "8"',
    'batches[0].backend[2].after 应是 domain 名的列表：true 应是字符串，写成 "true"',
  ]);
});
