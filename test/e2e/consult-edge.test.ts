// 架构师咨询的异常路径：咨询失败用尽（主会话重试、或用户代替架构师回答）、提问的任务被取消、架构师会话太大时开新会话并带上 decisions.md。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML, type Project } from '../helpers/project.ts';
import { hard, mkTask } from '../helpers/tasks.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { sessionDirOf } from '../../src/core/engine/session-log.ts';
import { pendingDecisions } from '../../src/core/engine/decisions.ts';
import { MAX_FORK_BYTES } from '../../src/core/engine/dispatcher.ts';
import { flowAskArchitectMain, flowDecide, flowWait, statusText } from '../../src/tools/orchestrator-tools.ts';
import { runFlowCommand } from '../../src/commands/forge.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';

const YAML = PROJECT_YAML.replace(/  test:      ".*"/, '  test:      "true"');

function keepSession(p: Project, a: FakeAgent, bytes = 0): void {
  const dir = sessionDirOf(p.dir, a.env.run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 's.jsonl'), `{"type":"session"}\n${'x'.repeat(bytes)}`);
}
const launchesOf = (e: { launcher: { launched: { env: Record<string, string>; prompt: string; forkFrom?: string }[] } }, task: string) =>
  e.launcher.launched.filter((s) => s.env['PI_FORGE_TASK'] === task);

test('咨询失败用尽：咨询阻塞并交给主会话，提问的任务显示在等阻塞的咨询、forge_wait 返回；主会话 retry 后回答，提问的任务接着做完', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', role: 'backend' })] });
  let architectRuns = 0, retried = false;
  const e = engineEnv(p, async (role, nth, a) => {
    await a.call('forge_claim');
    if (role === 'backend' && nth === 1) {
      keepSession(p, a);
      await writeFiles(a, { 'src/server/t-001/a.ts': '// 待定\n' });
      assert.ok((await a.call('forge_ask_architect', { question: '分页参数叫什么？', kind: 'answer' })).ok);
      return;
    }
    if (role === 'architect') {
      // 主会话决定之前的运行什么都没提交就结束（计运行失败）
      architectRuns++;
      if (!retried) return;
      assert.ok((await a.call('forge_answer', { text: '用 page 与 size。' })).ok);
      return;
    }
    return submitWork(a, '完成', { 'src/server/t-001/a.ts': 'export const page = 1;\n' });
  });
  try {
    for (let i = 0; i < 4; i++) { await e.engine.pump(p.flowId); await drive(e, p.flowId); }
    const c = p.store.readTask(p.flowId, 'T-002');
    // 同样的原因连续失败：派发前交出去（blocked_by dispatcher），先由主会话决定
    assert.deepEqual([c.status, c.blocked_owner], ['blocked', 'orchestrator'], c.blocked_reason ?? '');
    assert.ok(architectRuns >= 2 && architectRuns <= 3, String(architectRuns));
    assert.match(statusText(p.store, e.engine, p.flowId), /T-001 在等的咨询 T-002 已阻塞/);
    assert.match((await flowWait(p.store, e.engine, { task_id: 'T-001', timeout_s: 3 }, p.config)).text, /^T-001 已是 blocked/);
    assert.ok(pendingDecisions(p.store, p.flowId).some((d) => d.id === 'T-002'));
    retried = true;
    await flowDecide(p.dir, p.store, p.config, e.engine, { target: 'T-002', decision: 'retry', note: '直接回答分页参数' });
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /架构师的回答（T-002）：\n用 page 与 size/);
  } finally { p.cleanup(); }
});

test('咨询阻塞并转交用户：需要你处理里写明 /forge unblock <咨询> "<回答>"；用户的回答当作架构师的回答结束咨询，提问的任务接着做完，阶段可以签收', async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1', role: 'backend' })] });
  let architectRuns = 0;
  const e = engineEnv(p, async (role, nth, a) => {
    await a.call('forge_claim');
    if (role === 'backend' && nth === 1) {
      keepSession(p, a);
      assert.ok((await a.call('forge_ask_architect', { question: '分页参数叫什么？', kind: 'answer' })).ok);
      return;
    }
    // 架构师每次都什么都没提交就结束
    if (role === 'architect') { architectRuns++; return; }
    return submitWork(a, '完成', { 'src/server/t-001/a.ts': 'export const page = 1;\n' });
  });
  try {
    for (let i = 0; i < 4; i++) { await e.engine.pump(p.flowId); await drive(e, p.flowId); }
    assert.equal(p.store.readTask(p.flowId, 'T-002').status, 'blocked');
    await flowDecide(p.dir, p.store, p.config, e.engine, { target: 'T-002', decision: 'user', note: '架构师一直没回答' });
    const runs = architectRuns;
    assert.match(renderStatus(p.store, p.config), /先处理咨询 T-002：\/forge unblock T-002 "<回答>"（你代替架构师回答，咨询结束）/);
    assert.match(statusText(p.store, e.engine, p.flowId), /- T-002：[^\n]*→ \/forge unblock T-002 "<回答>"（你代替架构师回答，咨询结束）或 \/forge unblock T-002 --reset（重新交给架构师）/);
    // /forge answer 只列咨询，不列在等它的提问方；对提问方执行 unblock 也是处理它在等的咨询（直接解除它，两份回答都到不了它）
    const list = await runFlowCommand('answer', e.cmd);
    assert.match(list, /- T-002「/);
    assert.doesNotMatch(list, /- T-001「/);
    const { worktree, branch } = p.store.readTask(p.flowId, 'T-002');
    assert.ok(worktree && existsSync(worktree) && branch);
    assert.match(await runFlowCommand('unblock T-001 "用 page 与 size。"', e.cmd), /已用你的回答结束咨询 T-002，T-001 接着做/);
    assert.equal(existsSync(worktree), false, '咨询的工作区删掉');
    assert.equal(p.git('branch', '--list', branch), '', '咨询的分支删掉');
    await drive(e, p.flowId);
    assert.deepEqual(e.errors, []);
    assert.equal(architectRuns, runs, '不再交给架构师');
    assert.deepEqual(['T-002', 'T-001'].map((id) => p.store.readTask(p.flowId, id).status), ['done', 'done']);
    assert.match(p.store.readHandoff(p.flowId, 'T-001'), /架构师的回答（T-002）：\n（用户代替架构师回答）\n用 page 与 size/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(await runFlowCommand('approve --yes', e.cmd), /已批准阶段 S1/);
  } finally { p.cleanup(); }
});

test(`架构师上一次会话超过 ${MAX_FORK_BYTES} 字节：下一个咨询开新会话，任务说明带上 decisions.md`, async () => {
  const p = await setupProject({ yaml: YAML, stages: ['S1', 'S2'],
    tasks: [mkTask('T-001', { stage: 'S1', deps: [hard('T-009')] }), mkTask('T-009', { stage: 'S2' })] });
  let n = 0;
  const e = engineEnv(p, async (_role, _nth, a) => {
    await a.call('forge_claim');
    n++;
    keepSession(p, a, n === 1 ? MAX_FORK_BYTES + 1 : 0);
    await writeFiles(a, { 'docs/arch/decisions.md': `# 架构决定\n- 第 1 次咨询：金额按分存整数\n${n > 1 ? '- 第 2 次咨询：导出用 CSV\n' : ''}` });
    assert.ok((await a.call('forge_answer', { text: n === 1 ? '金额用整数分。' : '导出用 CSV。' })).ok);
  });
  try {
    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '金额怎么存？', kind: 'answer' });
    await e.engine.idle();
    await flowAskArchitectMain(p.store, p.config, e.engine, { question: '导出用什么格式？', kind: 'answer' });
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const [second] = launchesOf(e, 'T-011');
    assert.ok(second, '第二个咨询派发了');
    assert.equal(second!.forkFrom, undefined, '会话太大，不接着');
    assert.match(second!.prompt, /之前的架构决定（docs\/arch\/decisions\.md）[\s\S]*第 1 次咨询：金额按分存整数/);
    assert.equal(p.store.readTask(p.flowId, 'T-011').status, 'done');
  } finally { p.cleanup(); }
});
