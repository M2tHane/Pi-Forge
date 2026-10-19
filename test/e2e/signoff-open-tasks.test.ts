// 签收时本阶段还有没结束的任务（咨询、修复）：/forge-approve 被拒并列出这些任务，主会话的下一步也不是请用户签收；它们完成后照常批准。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { drive, engineEnv, submitWork } from '../helpers/commands.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { flowAskArchitectMain } from '../../src/tools/orchestrator-tools.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');

test('等签收时一个咨询在运行、一个在排队：/forge-approve 被拒并列出两者 → 咨询完成后可以批准', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1' })] });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const e = engineEnv(p, async (role, _nth, a) => {
    await a.call('forge_claim');
    if (role === 'architect') {
      await gate;
      assert.ok((await a.call('forge_answer', { text: '按名称排序。' })).ok);
      return;
    }
    return submitWork(a, a.env.task, { 'src/server/t-001/a.ts': 'ok\n' });
  });
  try {
    await drive(e, p.flowId);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '列表按什么排序？', kind: 'answer' });
    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '导出用什么格式？', kind: 'answer' });
    void e.engine.next(p.flowId);
    for (let i = 0; i < 200 && p.store.readTask(p.flowId, 'T-002').status !== 'in_progress'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(['T-002', 'T-003'].map((id) => p.store.readTask(p.flowId, id).status), ['in_progress', 'ready'], '咨询串行：一个在跑，一个在排队');

    await assert.rejects(runFlowCommand('approve --yes', e.cmd), /阶段 S1 还有 2 个任务没结束，完成后再批准：\n- T-002（consult，in_progress）[^\n]*\n- T-003（consult，ready）/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.doesNotMatch(nextStep(p.store, 3, 1, p.config).next, /forge-approve 批准|请其 \/forge-approve/, '主会话不提醒用户签收');

    release();
    await e.engine.idle();
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.deepEqual(['T-002', 'T-003'].map((id) => p.store.readTask(p.flowId, id).status), ['done', 'done']);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await runFlowCommand('approve --yes', e.cmd), /已批准阶段 S1/);
  } finally { release(); p.cleanup(); }
});

test('等签收时本阶段还有没开始的任务：主会话的下一步写明完成后再签收，/forge-approve 被拒', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1', 'S2'], tasks: [mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S2' })] });
  try {
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'forge_wait');
    assert.match(step.next, /阶段 S1 还有任务没结束：T-001（impl，pending）。它们完成后再请用户签收/);
    const e = engineEnv(p, async () => { throw new Error('不应派发'); });
    await assert.rejects(runFlowCommand('approve', e.cmd), /还有 1 个任务没结束[\s\S]*- T-001（impl，pending）任务 T-001/);
  } finally { p.cleanup(); }
});
