// 阶段验收编排：afterChecks 与 stageStep 的分支（不跑命令：检查结果直接构造）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { PRD_FILES } from '../helpers/prd.ts';
import { commitToBranch } from '../helpers/engine.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { acceptedHead, afterChecks, gatePassedHead, sameWork, stageStep, stageWorkSettled } from '../../src/core/stage/stage-acceptance.ts';
import { runImplementationChecks } from '../../src/core/stage/gates.ts';
import { decide, pendingDecisions } from '../../src/core/engine/decisions.ts';
import { taskRel } from '../../src/core/state/state-store.ts';
import { QA_INPUT, QA_REPORT } from '../../src/core/stage/stage-qa.ts';
import { evidenceRel } from '../../src/core/state/state-store.ts';
import { mkdirSync } from 'node:fs';
import { approveStage } from '../../src/core/stage/stages.ts';

const FILES = PRD_FILES;

function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

async function project(qa: boolean) {
  const yaml = qa ? PROJECT_YAML.replace(/^  qa: false$/m, '  qa: true') : PROJECT_YAML;
  const p = await setupProject({ yaml, files: FILES, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', layers: ['backend'] })] });
  await p.store.setStages(p.flowId, [{ id: 'S1', goal: '可以创建看板', exit: ['REQ-001'] }], 'standard');
  force(p, 'T-001', { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
  commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'src/server/t-001/a.ts': 'export const a = 1;\n' }, '实现');
  await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  return { p, deps: { root: p.dir, store: p.store, config: qa ? parseConfig(yaml) : p.config } };
}
const head = (p: Project) => p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch);
const checks = (p: Project, over: Record<string, unknown> = {}) => ({ stage: 'S1', passed: true, reasons: [], head: head(p), ...over });

test('gatePassedHead 取最近一次通过时的 HEAD，阶段被打回后作废；stageWorkSettled 不看阶段级 task', () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ type, flow: 'B-001', data });
  assert.equal(gatePassedHead([ev('note', { kind: 'gate_checks_passed', stage: 'S1', head: 'a' }), ev('note', { kind: 'gate_checks_passed', stage: 'S2', head: 'b' })], 'B-001', 'S1'), 'a');
  assert.equal(gatePassedHead([ev('note', { kind: 'gate_checks_passed', stage: 'S1', head: 'a' }), ev('stage_reopened', { stage: 'S1' })], 'B-001', 'S1'), null);
  const t = (id: string, kind: string, status: string) => ({ id, kind, status, stage: 'S1' }) as never;
  assert.equal(stageWorkSettled([t('T-001', 'impl', 'done'), t('S1.qa', 'qa', 'in_progress')], 'S1'), true);
  assert.equal(stageWorkSettled([t('T-001', 'impl', 'done'), t('T-001.fx-1', 'fix', 'ready')], 'S1'), false);
});

test('acceptedHead：最近一次验收出结果（转签收或 needs_human）时的 HEAD；从 needs_human 放行不改变它', () => {
  const gate = (to: string, head: string, stage = 'S1') => ({ type: 'gate_result', flow: 'B-001', to, data: { stage, head } });
  const accept = { type: 'transition', flow: 'B-001', to: 'awaiting_human', data: { stage: 'S1' } };
  assert.equal(acceptedHead([gate('awaiting_human', 'a'), gate('awaiting_human', 'b')], 'B-001', 'S1'), 'b');
  assert.equal(acceptedHead([gate('needs_human', 'a'), accept], 'B-001', 'S1'), 'a', '放行之前合入的也要和这一次比');
  assert.equal(acceptedHead([gate('awaiting_human', 'a'), gate('awaiting_human', 'b', 'S2')], 'B-001', 'S1'), 'a', '别的阶段的验收不算');
  assert.equal(acceptedHead([gate('active', 'a')], 'B-001', 'S1'), null);
});

test('不跑 stage-qa：通过 → 签收（awaiting_human，最后一个阶段）', async () => {
  const { p, deps } = await project(false);
  try {
    const r = await afterChecks(deps, p.flowId, checks(p));
    assert.equal(r.done, false);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(gatePassedHead(p.store.readEvents(), p.flowId, 'S1'), head(p));
  } finally { p.cleanup(); }
});

test('跑 stage-qa：通过 → 建 S1.qa（ready），阶段留在 awaiting_gate；qa 通过且 HEAD 未变 → 签收', async () => {
  const { p, deps } = await project(true);
  try {
    await afterChecks(deps, p.flowId, checks(p));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
    assert.equal(p.store.readTask(p.flowId, 'S1.qa').status, 'ready');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    // 模拟 stage-qa 提交通过
    force(p, 'S1.qa', { status: 'done' });
    const dir = path.join(p.dir, '.forge', evidenceRel(p.flowId, 'S1.qa'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, QA_REPORT), JSON.stringify({ round: 1, requested: 'pass', verdict: 'pass', issues: [], head: head(p) }));
    assert.ok(JSON.parse(readFileSync(path.join(dir, QA_INPUT), 'utf8')).head);
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'changed');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
});

test('stage-qa 通过但带建议：记录建议的提交不让验收作废，直接签收（不再开新一轮）', async () => {
  const { p, deps } = await project(true);
  try {
    await afterChecks(deps, p.flowId, checks(p));
    force(p, 'S1.qa', { status: 'done' });
    const dir = path.join(p.dir, '.forge', evidenceRel(p.flowId, 'S1.qa'));
    mkdirSync(dir, { recursive: true });
    const sug = { id: 'R-1', level: 'suggest', basis: 'defect:x', files: ['src/server/t-001/a.ts'], location: 'a', problem: '可以更好', expected: '改进' };
    writeFileSync(path.join(dir, QA_REPORT), JSON.stringify({ round: 1, requested: 'pass', verdict: 'pass', issues: [sug], head: head(p) }));
    const before = head(p);
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'changed');
    assert.notEqual(head(p), before, '建议已提交到集成分支');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.id === 'S1.qa-2'), '没有开第二轮');
  } finally { p.cleanup(); }
});

test('sameWork：只改了审查建议、覆盖率矩阵或架构决定记录算同一份代码，改了代码不算', async () => {
  const { p } = await project(false);
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const a = head(p);
    const b = commitToBranch(p.dir, integ, { 'docs/review/suggestions.md': '# x\n', 'docs/qa/S1.md': '# m\n', 'docs/arch/decisions.md': '# 决定\n' }, '记录');
    const c = commitToBranch(p.dir, integ, { 'src/server/t-001/a.ts': 'export const a = 2;\n' }, '改代码');
    assert.equal(sameWork(p.dir, a, b), true);
    assert.equal(sameWork(p.dir, a, c), false);
    assert.equal(sameWork(p.dir, null, a), false);
  } finally { p.cleanup(); }
});

test('门禁命令失败且无法归属 → needs_human；/forge gate（force）从 needs_human 重跑', async () => {
  const { p, deps } = await project(false);
  try {
    const r = await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed: { command: 'test', output: 'boom' } }));
    assert.match(r.note ?? '', /无法从日志定位/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    assert.equal(await stageStep(deps, p.flowId, { force: true, gateFailedWithoutChange: () => false }), 'gate');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
  } finally { p.cleanup(); }
});

test('门禁命令失败、日志能归属 → 建 .fx-1 回 active；第三次失败（两轮用尽）→ needs_human', async () => {
  const { p, deps } = await project(false);
  try {
    const failed = { command: 'test', output: 'Error at src/server/t-001/a.ts:1' };
    await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed }));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    const fx = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual([fx.kind, fx.for_task, fx.writes], ['fix', 'T-001', ['src/server/t-001/a.ts']]);
    for (const n of [2, 3]) {
      force(p, `T-001.fx-${n - 1}`, { status: 'done' });
      await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
      await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['test 失败'], failed }));
    }
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
  } finally { p.cleanup(); }
});

test('不需要人工签收的阶段：本阶段还有没结束的咨询时门禁通过也先不推进（不反复重跑门禁），咨询结束后通过并进入下一阶段', async () => {
  const yaml = PROJECT_YAML.replace(/^  human: true$/m, '  human: false');
  const p = await setupProject({ yaml, files: FILES, stages: ['S1', 'S2'], tasks: [mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S1', kind: 'consult', role: 'architect' })] });
  try {
    const deps = { root: p.dir, store: p.store, config: parseConfig(yaml) };
    force(p, 'T-001', { status: 'done', base_sha: p.git('rev-parse', 'HEAD') });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    assert.deepEqual(await afterChecks(deps, p.flowId, checks(p)), { done: false });
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait', '咨询没结束：等它，不重跑门禁');
    force(p, 'T-002', { status: 'done' });
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'gate');
    assert.equal((await afterChecks(deps, p.flowId, checks(p))).done, true);
    assert.deepEqual([p.store.readFlow(p.flowId).stage, p.store.readFlow(p.flowId).stage_status], ['S2', 'active'], '转 done 与进入下一阶段在同一事务里');
  } finally { p.cleanup(); }
});

test('批准批次阶段：转 done 与进入下一阶段在同一事务里，推进失败时批准也不生效，重试照常批准', async () => {
  const p = await setupProject({ files: FILES, stages: ['S1', 'S2'], tasks: [mkTask('T-001', { stage: 'S1' })] });
  try {
    force(p, 'T-001', { status: 'done' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
    const store = p.store as unknown as { advanceInTx: (...a: unknown[]) => unknown };
    const real = store.advanceInTx;
    store.advanceInTx = () => { store.advanceInTx = real; throw new Error('推进时出错'); };
    const d = { root: p.dir, store: p.store, config: p.config };
    await assert.rejects(approveStage(d, p.flowId), /推进时出错/);
    assert.deepEqual([p.store.readFlow(p.flowId).stage, p.store.readFlow(p.flowId).stage_status], ['S1', 'awaiting_human'], '没有停在 done');
    assert.match(await approveStage(d, p.flowId), /进入阶段 S2/);
  } finally { p.cleanup(); }
});

test('门禁命令运行期间有代码合入：结果记的是命令跑在的 HEAD，不进入签收，下一次推进重跑门禁', async () => {
  const { p, deps } = await project(false);
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const start = head(p);
    p.git('branch', 'side', integ);
    const merged = commitToBranch(p.dir, 'side', { 'src/server/t-001/a.ts': 'export const a = 2;\n' }, '运行期间合入的咨询改动');
    // test 命令本身通过；运行期间把集成分支移到 merged（模拟合并队列合入）。门禁 worktree 与仓库共用分支
    (p.config.commands as Record<string, string>)['test'] = `git update-ref refs/heads/${integ} ${merged} ${start}`;
    const g = await runImplementationChecks(p.dir, p.store, p.config, p.flowId);
    assert.deepEqual([g.passed, g.head, head(p) !== start], [true, start, true]);
    await afterChecks(deps, p.flowId, g);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate', '没跑过门禁的提交不能签收');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'gate');
  } finally { p.cleanup(); }
});

test('stage-qa 被 forge_block：阶段不转 needs_human（只有任务级的一项待决定）；主会话让它重做、提交结论后照常处理', async () => {
  const { p, deps } = await project(true);
  try {
    await afterChecks(deps, p.flowId, checks(p));
    force(p, 'S1.qa', { status: 'blocked', blocked_by: 'agent', blocked_reason: '服务起不来', blocked_owner: 'orchestrator' });
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
    assert.deepEqual(pendingDecisions(p.store, p.flowId).map((d) => d.id), ['S1.qa']);
    await decide(deps, p.flowId, 'S1.qa', 'retry', '服务端口改用 FORGE_PORT 再试');
    // 重做后提交了 must
    force(p, 'S1.qa', { status: 'done' });
    const dir = path.join(p.dir, '.forge', evidenceRel(p.flowId, 'S1.qa'));
    mkdirSync(dir, { recursive: true });
    const must = { id: 'R-1', level: 'must', basis: 'defect:x', files: ['src/server/t-001/a.ts'], location: 'a', problem: 'p', expected: 'e' };
    writeFileSync(path.join(dir, QA_REPORT), JSON.stringify({ round: 1, requested: 'changes', verdict: 'changes', issues: [must], head: head(p) }));
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'changed');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'active');
    assert.equal(p.store.readTask(p.flowId, 'T-001.fx-1').kind, 'fix');
  } finally { p.cleanup(); }
});

test('等签收时：只合入了决定记录（回答纯问题）不重新验收；代码变了退回 active 重新验收', async () => {
  const { p, deps } = await project(false);
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    await afterChecks(deps, p.flowId, checks(p));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    commitToBranch(p.dir, integ, { 'docs/arch/decisions.md': '## 咨询 T-002\n结论：不用改\n' }, '架构师回答');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'wait');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    commitToBranch(p.dir, integ, { 'src/server/t-001/a.ts': 'export const a = 2;\n' }, '架构师的修改');
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'gate');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
  } finally { p.cleanup(); }
});

test('needs_human 之后合入代码、再放行到签收：和转 needs_human 时验收的 HEAD 比，仍要重新验收', async () => {
  const { p, deps } = await project(false);
  try {
    await afterChecks(deps, p.flowId, checks(p, { passed: false, reasons: ['工作区准备失败'] }));
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'needs_human');
    commitToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, { 'src/server/t-001/a.ts': 'export const a = 2;\n' }, '放行前合入');
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'accept', actor: 'human', reason: '放行' });
    assert.equal(await stageStep(deps, p.flowId, { gateFailedWithoutChange: () => false }), 'gate');
  } finally { p.cleanup(); }
});

test('签收时验收之后代码又变了（程序还没来得及退回重新验收）：拒绝批准；只合入了决定记录照常批准', async () => {
  const { p, deps } = await project(false);
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    await afterChecks(deps, p.flowId, checks(p));
    commitToBranch(p.dir, integ, { 'src/server/t-001/a.ts': 'export const a = 2;\n' }, '刚合入的修改');
    await assert.rejects(approveStage(deps, p.flowId), /验收之后集成分支的代码又有了改动/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
  } finally { p.cleanup(); }
  const second = await project(false);
  try {
    await afterChecks(second.deps, second.p.flowId, checks(second.p));
    commitToBranch(second.p.dir, second.p.store.readFlow(second.p.flowId).integration_branch, { 'docs/arch/decisions.md': '## 咨询\n结论：不用改\n' }, '架构师回答');
    assert.match(await approveStage(second.deps, second.p.flowId), /已批准阶段 S1/);
  } finally { second.p.cleanup(); }
});
