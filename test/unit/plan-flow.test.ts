// 架构阶段 S0：程序派的 architect task、提交时的检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cancelTask, setupProject } from '../helpers/project.ts';
import { approvablePlan, checkArchitecture, ensureArchitectTask } from '../../src/core/plan/plan-flow.ts';
import { ARCH_FILES } from '../helpers/arch.ts';
import { approveStage, rejectStage } from '../../src/core/stage/stages.ts';
import type { Project } from '../helpers/project.ts';

const toAwaitingHuman = async (p: Project) => {
  await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
  await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'gate', needs_human: true });
};
/** 用户打回 S0（经 /forge-reject 背后的 rejectStage） */
const reject = async (p: Project, why: string) => {
  await toAwaitingHuman(p);
  await rejectStage({ root: p.dir, store: p.store, config: p.config }, p.flowId, why);
};

test('ensureArchitectTask：S0 active 时建一个 architect 的 impl task；有了就不再建；打回后新建一个接着上一个的会话', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    const t = await ensureArchitectTask(p.store, p.config, p.flowId);
    assert.ok(t, '新建了 architect task');
    assert.deepEqual([t.id, t.kind, t.role, t.stage], ['T-001', 'impl', 'architect', 'S0']);
    for (const w of ['**', 'rules/**', 'tests/acceptance/S0-smoke/**', 'tests/acceptance/_support/**', 'tests/acceptance/T-001/**']) assert.ok(t.writes.includes(w), w);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /# S0 架构[\s\S]*docs\/plan\.md/);
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null, '还在进行中');
    await cancelTask(p, p.flowId, 'T-001');
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null, '已有 architect task 且没要求返工');
    await reject(p, 'domain 拆得太细');
    const rework = (await ensureArchitectTask(p.store, p.config, p.flowId))!;
    assert.equal(rework.id, 'T-002');
    assert.match(rework.title, /返工/);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /需要返工[\s\S]*domain 拆得太细/);
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
  } finally { p.cleanup(); }
});

test('ensureArchitectTask：多次打回时返工说明按时间顺序列出历次意见，标出这次的（开新会话时也看得到前几次要过什么）', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    await ensureArchitectTask(p.store, p.config, p.flowId);
    for (const [id, why] of [['T-001', 'domain 拆得太细'], ['T-002', '订单要单独一个 domain']] as const) {
      await cancelTask(p, p.flowId, id);
      await reject(p, why);
      await ensureArchitectTask(p.store, p.config, p.flowId);
    }
    const brief = p.store.readHandoff(p.flowId, 'T-003');
    assert.match(brief, /被打回了 2 次[\s\S]*1\. domain 拆得太细\n2\. （这次）订单要单独一个 domain/);
  } finally { p.cleanup(); }
});

test('ensureArchitectTask：建返工任务中途中断时，任务、说明与返工标记要么都写了、要么都没写（不会按同一条意见返工两次）', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    await ensureArchitectTask(p.store, p.config, p.flowId);
    await cancelTask(p, p.flowId, 'T-001');
    await reject(p, 'domain 拆得太细');
    // 第一个事务提交之后的下一个事务失败，相当于进程在两次写入之间退出
    const real = p.store.transaction.bind(p.store);
    let calls = 0;
    p.store.transaction = (async (fn: Parameters<typeof real>[0]) => { if (++calls > 1) throw new Error('模拟中断'); return real(fn); }) as typeof real;
    await ensureArchitectTask(p.store, p.config, p.flowId).catch(() => null);
    p.store.transaction = real;
    const made = p.store.listTasks(p.flowId).some((t) => t.id === 'T-002');
    assert.equal(made, true);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /需要返工[\s\S]*domain 拆得太细/);
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
  } finally { p.cleanup(); }
});

test('打回 S0：退回 active 与返工意见一起写入，中途中断时不会停在 active 却没有返工任务', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    await ensureArchitectTask(p.store, p.config, p.flowId);
    await cancelTask(p, p.flowId, 'T-001');
    await toAwaitingHuman(p);
    // 第一个事务提交之后的下一个事务失败，相当于进程在两次写入之间退出
    const real = p.store.transaction.bind(p.store);
    let calls = 0;
    p.store.transaction = (async (fn: Parameters<typeof real>[0]) => { if (++calls > 1) throw new Error('模拟中断'); return real(fn); }) as typeof real;
    await rejectStage({ root: p.dir, store: p.store, config: p.config }, p.flowId, 'domain 拆得太细').catch(() => null);
    p.store.transaction = real;
    const f = p.store.readFlow(p.flowId);
    assert.deepEqual([f.stage_status, f.plan_rework?.reason], ['active', '用户打回：domain 拆得太细']);
    assert.equal((await ensureArchitectTask(p.store, p.config, p.flowId))?.id, 'T-002');
  } finally { p.cleanup(); }
});

test('ensureArchitectTask：不在 S0、或计划已经落地时不建', async () => {
  const p = await setupProject({ stages: ['S1'] });
  try {
    assert.equal(await ensureArchitectTask(p.store, p.config, p.flowId), null);
  } finally { p.cleanup(); }
});

test('checkArchitecture：缺必需文件、commands.yaml 没有 test、plan.md 解析不过、需求没进批次是错误；PRD 的其他问题只提醒', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-arch-'));
  const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
  };
  try {
    assert.equal(checkArchitecture({ dir }).errors.length, 7, '七个必需文件都缺（commands.yaml 报缺 test）');
    write(ARCH_FILES);
    const ok = checkArchitecture({ dir });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.plan?.batches.length, 2);
    assert.deepEqual(ok.warnings, []);
    write({ 'docs/PRD.md': `${ARCH_FILES['docs/PRD.md']}\n### 报表  REQ-004\n- AC1 Given 有单据 When 打开报表 Then 看到汇总\n` });
    assert.match(checkArchitecture({ dir }).errors.join('\n'), /PRD 里这些需求没有出现在任何批次：REQ-004/);
    write({ 'docs/PRD.md': ARCH_FILES['docs/PRD.md']! });
    write({ 'commands.yaml': 'commands:\n  serve: "node a.js"\n', 'docs/plan.md': ARCH_FILES['docs/plan.md']!.replace('after: [catalog]', 'after: [ghost]') });
    assert.deepEqual(checkArchitecture({ dir }).errors, ['commands.yaml 缺少 test 命令（阶段门禁与合并后回归要跑全量测试）', 'domain inventory 的 after 指向不存在的 domain ghost']);
    rmSync(path.join(dir, 'docs/prototype/products.html'));
    assert.ok(checkArchitecture({ dir }).warnings.some((w) => /PRD：页面「products」的原型文件 docs\/prototype\/products\.html 不存在/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S0 不能批准或打回时，报错写明阶段状态与下一步；计划失效时提示用 /forge-reject 让架构师修', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    const d = { root: p.dir, store: p.store, config: p.config };
    await assert.rejects(approveStage(d, p.flowId), /阶段 S0 现在还在进行中，还不能批准。[\s\S]*\/forge-status/);
    await assert.rejects(rejectStage(d, p.flowId, '再想想'), /阶段 S0 现在还在进行中，还不能打回/);
    assert.throws(() => approvablePlan(p.dir, p.store.readFlow(p.flowId).integration_branch), /不能批准[\s\S]*用 \/forge-reject "<意见>" 让架构师修/);
  } finally { p.cleanup(); }
});
