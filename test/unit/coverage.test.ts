// 阶段验收覆盖率（矩阵、渲染、报告提交、补测轮次）与实施阶段程序检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageMatrix, renderCoverageMarkdown, stageCoverage, writeCoverageReport } from '../../src/core/acceptance/coverage.ts';
import { gateFailed, gateIssues, runImplementationChecks, stageDef } from '../../src/core/stage/gates.ts';
import type { FlowConfig } from '../../src/core/state/config.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskRel } from '../../src/core/state/state-store.ts';

const req = (id: string, acs: string[]) => ({ id, acs: acs.map((a) => ({ id: a, text: `${a} 的内容`, line: 1 })) });
const REQS = [req('REQ-001', ['AC1', 'AC2']), req('REQ-002', ['AC1']), req('REQ-003', ['AC1'])];
const TASKS = [
  { id: 'T-001', kind: 'impl', status: 'done', ac: ['REQ-001.AC1', 'REQ-001.AC2'] },
  { id: 'T-002', kind: 'impl', status: 'cancelled', ac: ['REQ-003.AC1'] },
  { id: 'T-003', kind: 'impl', status: 'done', ac: ['REQ-003.AC1'] },
] as const;

test('coverageMatrix：exit 里每条需求的每条 AC 一行，PRD 里没有的需求跳过；owner 忽略 cancelled，files 来自标签', () => {
  const rows = coverageMatrix({ reqs: REQS, exit: ['REQ-001', 'REQ-003', 'REQ-404'], tasks: TASKS, tests: new Map([['REQ-001.AC1', ['tests/acceptance/T-001/a.test.ts']]]) });
  assert.deepEqual(rows.map((r) => r.ac), ['REQ-001.AC1', 'REQ-001.AC2', 'REQ-003.AC1']);
  assert.deepEqual(rows.map((r) => r.owner), ['T-001', 'T-001', 'T-003']);
  assert.deepEqual(rows.map((r) => r.files.length), [1, 0, 0]);
});

test('coverageMatrix：exit 外的需求不计；没有 task 认领的 AC 没有 owner', () => {
  const rows = coverageMatrix({ reqs: REQS, exit: ['REQ-003'], tasks: [], tests: new Map() });
  assert.deepEqual(rows, [{ req: 'REQ-003', ac: 'REQ-003.AC1', text: 'AC1 的内容', files: [] }]);
});

test('renderCoverageMarkdown：表格与缺口汇总', () => {
  const md = renderCoverageMarkdown('S1', '登录', [
    { req: 'REQ-001', ac: 'REQ-001.AC1', text: 'a | b', owner: 'T-001', files: ['tests/acceptance/T-001/a.test.ts'] },
    { req: 'REQ-001', ac: 'REQ-001.AC2', text: 'c', files: [] },
  ]);
  assert.match(md, /# 阶段 S1 验收覆盖/);
  assert.match(md, /\| REQ-001 \| REQ-001\.AC1 \| a \\\| b \| T-001 \| `tests\/acceptance\/T-001\/a\.test\.ts` \|/);
  assert.match(md, /\*\*缺口\*\*/);
  assert.match(md, /缺口：1 \/ 2 条 AC 没有带编号的验收测试：REQ-001\.AC2/);
  assert.match(renderCoverageMarkdown('S1', 'x', []), /本阶段没有需要自动验收的 AC/);
  assert.match(renderCoverageMarkdown('S1', 'x', [{ req: 'R', ac: 'R.AC1', files: ['f'] }]), /缺口：无（1 条/);
});

const SPEC = {
  'docs/PRD.md': '# PRD\n\n### 登录 REQ-001\n- AC1 Given 已注册 When 登录 Then 成功\n- AC2 Given 密码错误 When 登录 Then 失败\n',
  'tests/acceptance/T-001/login.test.ts': "test('[REQ-001.AC1] 登录成功', () => {});\n",
  'src/server/t-001/a.ts': 'export const a = 1;\n',
};

async function project(extra: Record<string, string> = {}) {
  const p = await setupProject({ stages: ['S1'], files: { ...SPEC, ...extra }, tasks: [mkTask('T-001', { stage: 'S1', status: 'done', ac: ['REQ-001.AC1', 'REQ-001.AC2'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '登录', exit: ['REQ-001', 'REQ-002'] }], 'standard');
  return p;
}

test('stageCoverage：从集成分支读 PRD 与验收测试，缺口就是没有标签的 AC', async () => {
  const p = await project();
  try {
    const r = stageCoverage(p.dir, p.store, p.config, p.flowId, 'S1', p.store.readFlow(p.flowId).integration_branch);
    assert.deepEqual(r.rows.map((x) => [x.ac, x.files.length, x.owner]), [['REQ-001.AC1', 1, 'T-001'], ['REQ-001.AC2', 0, 'T-001']]);
    assert.deepEqual(r.gaps.map((x) => x.ac), ['REQ-001.AC2']);
    assert.match(r.markdown, /REQ-001\.AC2/);
    assert.throws(() => stageCoverage(p.dir, p.store, p.config, p.flowId, 'S9', 'main'), /没有阶段 S9/);
  } finally { p.cleanup(); }
});

test('writeCoverageReport：提交到 docs/qa/<stage>.md，内容不变不再提交', async () => {
  const p = await project();
  try {
    const branch = p.store.readFlow(p.flowId).integration_branch;
    const before = p.git('rev-parse', branch);
    await writeCoverageReport(p.dir, p.store, p.flowId, 'S1', '# 报告\n');
    const h1 = p.git('rev-parse', branch);
    assert.notEqual(h1, before);
    assert.equal(p.git('show', `${branch}:docs/qa/S1.md`), '# 报告');
    await writeCoverageReport(p.dir, p.store, p.flowId, 'S1', '# 报告\n');
    assert.equal(p.git('rev-parse', branch), h1);
  } finally { p.cleanup(); }
});

test('runImplementationChecks：命令通过后写覆盖报告；缺口只报告、不拦门禁，不迁移阶段', async () => {
  const p = await project();
  try {
    const before = p.store.readFlow(p.flowId);
    const start = p.git('rev-parse', before.integration_branch);
    const r = await runImplementationChecks(p.dir, p.store, p.config, p.flowId);
    assert.equal(r.passed, true);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.failed, undefined);
    assert.deepEqual(r.coverage?.gaps.map((g) => g.ac), ['REQ-001.AC2']);
    const branch = before.integration_branch;
    assert.equal(r.head, start, '记的是命令跑在的 HEAD，不是写完覆盖报告之后的');
    assert.match(p.git('show', `${branch}:docs/qa/S1.md`), /REQ-001\.AC2/);
    const after = p.store.readFlow(p.flowId);
    assert.equal(after.stage_status, before.stage_status);
    assert.equal(after.stage, before.stage);
  } finally { p.cleanup(); }
});

test('runImplementationChecks：覆盖齐全则通过；命令失败不算覆盖率', async () => {
  const p = await project({ 'tests/acceptance/T-001/more.test.ts': "test('[REQ-001.AC2] 失败', () => {});\n" });
  try {
    const ok = await runImplementationChecks(p.dir, p.store, p.config, p.flowId);
    assert.equal(ok.passed, true);
    assert.deepEqual(ok.coverage?.gaps, []);
  } finally { p.cleanup(); }
  const bad = await project({ 'src/server/t-001/a.ts': 'FAIL\n' });
  try {
    const r = await runImplementationChecks(bad.dir, bad.store, bad.config, bad.flowId);
    assert.equal(r.passed, false);
    assert.equal(r.failed?.command, 'test');
    assert.equal(r.coverage, undefined);
    assert.ok(!bad.git('ls-tree', '-r', '--name-only', bad.store.readFlow(bad.flowId).integration_branch).includes('docs/qa/S1.md'));
  } finally { bad.cleanup(); }
});

test('stageDef：没配置 auto 时门禁默认跑 test、acceptance、arch_check、contract_check，commands 里没定义的跳过', () => {
  const config = (raw: object, commands: Record<string, string>) => ({ raw, commands }) as unknown as FlowConfig;
  assert.deepEqual(stageDef(config({}, { test: 'npm test', arch_check: 'npm run arch', lint: 'eslint' }), 'S1').gate.auto, ['test', 'arch_check']);
  assert.deepEqual(stageDef(config({ implementation_gate: { auto: ['lint'] } }, { test: 'npm test', lint: 'eslint' }), 'S1').gate.auto, ['lint']);
});

test('gateIssues：同一次失败只生成一条问题；验收目录的 impl 作为候选负责者，测试文件不当作 worker 的文件', () => {
  const tasks = [mkTask('T-001'), mkTask('T-002', { writes: ['src/b/**'] })];
  const tracked = new Set(['src/b/x.ts', 'tests/acceptance/T-001/a.test.ts']);
  const out = 'FAIL tests/acceptance/T-001/a.test.ts\n at src/b/x.ts:3\n  tests/acceptance/T-404/z.test.ts';
  const issues = gateIssues({ command: 'test', output: out }, tasks, tracked);
  assert.deepEqual(issues.map((i) => [i.files, i.candidates, i.owner]), [[['src/b/x.ts'], ['T-001'], undefined]]);
  assert.match(issues[0]!.text, /全量 test 失败/);
  assert.deepEqual(gateIssues({ command: 'test', output: 'FAIL tests/acceptance/T-001/a.test.ts' }, tasks, tracked).map((i) => [i.files, i.candidates]), [[[], ['T-001']]]);
  assert.deepEqual(gateIssues({ command: 'test', output: 'boom' }, tasks, tracked), []);
});

test('gateFailed：acceptance 日志同时有验收目录和源文件 → 一个修复任务；负责者不同时交给架构师，相同时交给那一个', async () => {
  const files = { 'src/b/x.ts': 'x\n', 'src/server/t-002/a.ts': 'a\n', 'tests/acceptance/T-002/a.test.ts': 't\n' };
  const tasks = [
    mkTask('T-001', { stage: 'S1', status: 'done', role: 'architect', writes: ['**', 'tests/acceptance/T-001/**'] }),
    mkTask('T-002', { stage: 'S1', status: 'done', role: 'backend', writes: ['src/server/t-002/**', 'tests/acceptance/T-002/**'] }),
    mkTask('T-003', { stage: 'S1', status: 'done', role: 'backend', writes: ['src/b/**'] }),
  ];
  const p = await setupProject({ stages: ['S1'], files, tasks });
  try {
    // addTasks 按依赖重算状态：直接改成 done
    for (const t of tasks) {
      const f = path.join(p.dir, '.forge', taskRel(p.flowId, t.id));
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), status: 'done' }, null, 2));
    }
    const d = { root: p.dir, store: p.store, config: p.config };
    const cross = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-002/a.test.ts\n at src/b/x.ts:3' });
    assert.deepEqual(cross.tasks, ['T-001.fx-1']);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-001.fx-1').writes, ['src/b/x.ts', 'tests/acceptance/T-001/**']);
    const own = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-002/a.test.ts\n at src/server/t-002/a.ts:3' });
    assert.deepEqual(own.tasks, ['T-002.fx-1']);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-002.fx-1').writes, ['src/server/t-002/**', 'src/server/t-002/a.ts', 'tests/acceptance/T-002/**']);
  } finally { p.cleanup(); }
});

test('gateFailed：修复任务、说明与轮次记录一起写入，中途中断时不会留下没记轮次的修复（重跑门禁时会再建一组）', async () => {
  const p = await project();
  try {
    const d = { root: p.dir, store: p.store, config: p.config };
    // 第一个事务提交之后的下一个事务失败，相当于进程在两次写入之间退出
    const real = p.store.transaction.bind(p.store);
    let calls = 0;
    p.store.transaction = (async (fn: Parameters<typeof real>[0]) => { if (++calls > 1) throw new Error('模拟中断'); return real(fn); }) as typeof real;
    await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' }).catch(() => null);
    p.store.transaction = real;
    const fixes = p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix').map((t) => t.id);
    assert.deepEqual(p.store.readFlow(p.flowId).gate_rounds?.flatMap((r) => r.tasks) ?? [], fixes);
    for (const id of fixes) assert.match(p.store.readHandoff(p.flowId, id), /阶段门禁发现的问题/);
  } finally { p.cleanup(); }
});

test('gateFailed：生成 .fx-n（验收测试失败时 writes 为 impl 的 writes）并记一轮；满轮次或定位不到时给原因', async () => {
  const p = await project();
  try {
    const d = { root: p.dir, store: p.store, config: p.config };
    const none = await gateFailed(d, p.flowId, { command: 'test', output: 'boom' });
    assert.deepEqual(none.tasks, []);
    assert.match(none.reason ?? '', /无法从日志定位/);
    assert.equal(p.store.readFlow(p.flowId).gate_rounds, undefined);
    const r = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts > [REQ-001.AC1]' });
    assert.deepEqual(r.tasks, ['T-001.fx-1']);
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual(fx.writes, ['src/server/t-001/**']);
    assert.equal(fx.for_task, 'T-001');
    assert.deepEqual(p.store.readFlow(p.flowId).gate_rounds?.map((x) => [x.command, x.tasks]), [['acceptance', ['T-001.fx-1']]]);
    const r2 = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' });
    assert.deepEqual(r2.tasks, ['T-001.fx-2']);
    const r3 = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' });
    assert.deepEqual(r3.tasks, []);
    assert.match(r3.reason ?? '', /2 轮后仍失败/);
    // 打回之后重新计数：重开之前用掉的轮数不算
    const reopen = async () => {
      await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
      await p.store.transitionStage(p.flowId, { to: 'active', trigger: 'reject', actor: 'human', reason: '再改改' });
    };
    await reopen();
    const r4 = await gateFailed(d, p.flowId, { command: 'acceptance', output: 'FAIL tests/acceptance/T-001/login.test.ts' });
    assert.deepEqual(r4.tasks, ['T-001.fx-3']);
  } finally { p.cleanup(); }
});

