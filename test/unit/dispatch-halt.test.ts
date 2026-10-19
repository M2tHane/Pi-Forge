// 调度在预算用完、阶段不在 active、只读任务超时时的行为。fake-subagent 驱动真实的引擎（不使用真实模型）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../helpers/engine.ts';
import { setupProject, type Project } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { taskRel } from '../../src/core/state/state-store.ts';

/** 测试专用：直接改任务文件，构造调度前的状态 */
function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}
const launchedTasks = (launcher: { launched: { env: Record<string, string> }[] }) => launcher.launched.map((s) => s.env['PI_FORGE_TASK']);

test('预算用完：程序步骤跳过审查与被打回的任务，不报错，排在后面的 merge-fix 照常派发', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [
    mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S1' }),
    mkTask('T-001.rv', { stage: 'S1', kind: 'review', role: 'reviewer', for_task: 'T-001', writes: [], verify: [] }),
    mkTask('T-009', { stage: 'S1', kind: 'merge-fix', merge_fix_for: 'T-001', writes: ['src/server/t-001/a.ts'], verify: [] }),
  ] });
  try {
    const base = p.git('rev-parse', 'HEAD');
    force(p, 'T-001', { status: 'merging' });
    force(p, 'T-001.rv', { status: 'ready' });
    force(p, 'T-009', { status: 'ready' });
    // 审查打回、回到进行中且没有租约的任务
    force(p, 'T-002', { status: 'in_progress', worktree: p.dir, branch: 'b', base_sha: base });
    await p.store.setFlowBudget(p.flowId, { tokens: 100 });
    await p.store.createRun({ run_id: 'r-0', flow: p.flowId, task: 'T-002', role: 'worker', model: 'fake/model', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:10:00.000Z',
      tokens: { input: 200, output: 0, cache_read: 0, cache_write: 0 }, outcome: 'submitted', token_hash: 'a'.repeat(64), violations: 0 });
    const { engine, launcher, errors } = makeEngine(p, async (_role, _nth, a) => { await a.call('forge_claim'); });
    await engine.pump(p.flowId);
    await engine.idle();
    assert.deepEqual(errors.map(String), []);
    assert.deepEqual([...new Set(launchedTasks(launcher))], ['T-009'], '只派了 merge-fix（它没提交就结束，会再派一次）');
  } finally { p.cleanup(); }
});

test('阶段在等签收时生成的 merge-fix 也能就绪', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [mkTask('T-009', { stage: 'S1', kind: 'merge-fix', writes: ['src/a.ts'], verify: [] })] });
  try {
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    const { engine } = makeEngine(p, async () => {});
    assert.deepEqual(await engine.promote(p.flowId), ['T-009']);
    assert.equal(p.store.readTask(p.flowId, 'T-009').status, 'ready');
  } finally { p.cleanup(); }
});

test('审查超时：用的是被审查任务的工作区，程序不按它的提交判断进展，留给主会话复核', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [mkTask('T-001.rv', { stage: 'S1', kind: 'review', role: 'reviewer', for_task: 'T-001', writes: [], verify: [] })] });
  try {
    const base = p.git('rev-parse', 'HEAD');
    p.git('commit', '-q', '--allow-empty', '-m', '被审查任务的提交');
    force(p, 'T-001.rv', { status: 'in_progress', worktree: p.dir, branch: 'b', base_sha: base, timeout_review: { run: 'r-1', at: '2026-01-01T00:00:00.000Z', minutes: 15 } });
    const { engine } = makeEngine(p, async () => {});
    await (engine as unknown as { autoReviewTimeout(flowId: string, taskId: string): Promise<void> }).autoReviewTimeout(p.flowId, 'T-001.rv');
    assert.equal(p.store.readTask(p.flowId, 'T-001.rv').timeout_review?.decision, undefined);
  } finally { p.cleanup(); }
});

test('两次 /forge next 同时派发同一个任务：只派一次，后一次不报错', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1' })] });
  try {
    const { engine, launcher, errors } = makeEngine(p, async (_role, _nth, a) => { await a.call('forge_claim'); });
    const [a, b] = await Promise.all([engine.next(p.flowId), engine.next(p.flowId)]);
    assert.deepEqual([...a, ...b].map((d) => d.task), ['T-001']);
    assert.deepEqual(launchedTasks(launcher), ['T-001']);
    await engine.idle();
    assert.deepEqual(errors.map(String), []);
  } finally { p.cleanup(); }
});
