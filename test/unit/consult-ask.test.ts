// forge_ask_architect 的编号与失败处理：同时提问不撞号（编号在事务里分配，口径同计划任务）；提问的任务没能转为等待时撤回刚建的咨询；同一个任务并行提问只建一个咨询。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../../src/core/state/state-store.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { parseConfig } from '../../src/core/state/config.ts';
import { flowAskArchitect, type ToolContext } from '../../src/tools/subagent-tools.ts';
import { answerAsUser, latestConsultOf, resolveConsults } from '../../src/core/engine/consult.ts';
import { TEST_YAML } from '../helpers/config.ts';
import { tmpRepo } from '../helpers/repo.ts';
import { mkTask } from '../helpers/tasks.ts';

const config = parseConfig(TEST_YAML);
const T0 = Date.parse('2026-01-01T00:00:00Z');

async function setup(ids: string[]) {
  const repo = tmpRepo();
  // 主分支上已有 T-009 的验收目录（此前流程的任务）：新编号要跳过它
  mkdirSync(path.join(repo.dir, 'tests/acceptance/T-009'), { recursive: true });
  writeFileSync(path.join(repo.dir, 'tests/acceptance/T-009/a.test.ts'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  let clock = T0;
  const store = await StateStore.init(repo.dir, { now: () => new Date(clock), limits: config.limits });
  const flow = await store.createFlow({ mode: 'build', title: 'ask', stages: ['S1'], base_sha: 'abc' });
  await store.addTasks(flow.id, ids.map((id) => mkTask(id, { stage: 'S1', role: 'backend' })), 'architect');
  const wt = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  mkdirSync(wt, { recursive: true });
  const ctxs: ToolContext[] = [];
  for (const [i, id] of ids.entries()) {
    const run = `r-${i}`;
    await store.transitionTask(flow.id, id, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await store.transitionTask(flow.id, id, { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
      lease: { run_id: run, role: 'backend', token_hash: hashToken('t'), acquired_at: new Date(T0).toISOString(), expires_at: '2026-01-01T01:00:00Z' },
      worktree: wt, branch: `flow/B-001/${id}`, base_sha: 'abc' } });
    await store.createRun({ run_id: run, flow: flow.id, task: id, role: 'backend', model: null, started_at: new Date(T0).toISOString(), ended_at: null,
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, outcome: null, token_hash: hashToken('t'), violations: 0 });
    ctxs.push({ store, config, env: { root: repo.dir, flow: flow.id, task: id, run, token: 't', role: 'backend' }, now: () => new Date(T0) });
  }
  const cleanup = () => { repo.cleanup(); rmSync(wt, { recursive: true, force: true }); };
  return { store, flowId: flow.id, ctxs, setClock: (ms: number) => { clock = ms; }, cleanup };
}

test('两个子 agent 同时提问：都成功，编号不同，并跳过主分支上已有的验收目录', async () => {
  const { store, flowId, ctxs, cleanup } = await setup(['T-001', 'T-002']);
  try {
    const rs = await Promise.all(ctxs.map((c) => flowAskArchitect(c, { question: `${c.env.task} 的问题`, kind: 'answer' })));
    const ids = rs.map((r) => r.details!['consult'] as string).sort();
    assert.deepEqual(ids, ['T-010', 'T-011']);
    for (const id of ids) assert.equal(store.readTask(flowId, id).kind, 'consult');
    assert.deepEqual(['T-001', 'T-002'].map((id) => store.readTask(flowId, id).blocked_by), ['architect', 'architect']);
  } finally { cleanup(); }
});

test('提问的任务没能转为等待（租约在这期间过期）：提问报错，刚建的咨询被撤回', async () => {
  const { store, flowId, ctxs, setClock, cleanup } = await setup(['T-001']);
  try {
    setClock(Date.parse('2026-01-01T01:30:00Z'));
    await assert.rejects(flowAskArchitect(ctxs[0]!, { question: '分页参数叫什么？', kind: 'answer' }), /提问没有成功/);
    const consults = store.listTasks(flowId).filter((t) => t.kind === 'consult');
    assert.deepEqual(consults.map((t) => [t.id, t.status]), [['T-010', 'cancelled']]);
    assert.equal(store.readTask(flowId, 'T-001').status, 'in_progress');
  } finally { cleanup(); }
});

test('同一条消息里并行提问两次（Pi 并行执行工具调用）：只建一个咨询，另一次报错；提问的任务等的就是它，程序步骤不会提前恢复', async () => {
  const { store, flowId, ctxs, cleanup } = await setup(['T-001']);
  try {
    const rs = await Promise.allSettled([1, 2].map((n) => flowAskArchitect(ctxs[0]!, { question: `问题 ${n}`, kind: 'answer' })));
    assert.deepEqual(rs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const asked = (rs.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ details?: Record<string, unknown> }>).value.details!['consult'];
    const tasks = store.listTasks(flowId);
    assert.match(String((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), new RegExp(`已经在等架构师回答（${asked}）`));
    assert.equal(latestConsultOf(tasks, 'T-001')?.id, asked);
    assert.deepEqual(tasks.filter((t) => t.kind === 'consult' && t.status !== 'cancelled').map((t) => t.id), [asked]);
    assert.deepEqual(await resolveConsults(store, flowId), [], '咨询还没回答，不恢复提问的任务');
    assert.equal(store.readTask(flowId, 'T-001').blocked_by, 'architect');
  } finally { cleanup(); }
});

test('咨询的问题说明和任务在同一事务里写：建好的咨询一定带着问题', async () => {
  const { store, flowId, ctxs, cleanup } = await setup(['T-001']);
  try {
    // 单独追加 handoff 的写入失败（进程在两次写之间被杀）不影响咨询的说明
    store.appendHandoff = async () => { throw new Error('不应单独追加'); };
    const r = await flowAskArchitect(ctxs[0]!, { question: '分页参数叫什么？', kind: 'answer' });
    assert.match(store.readHandoff(flowId, r.details!['consult'] as string), /## 问题\n分页参数叫什么？/);
  } finally { cleanup(); }
});

test('恢复提问方时追加回答后、转移前被杀：再次恢复时回答不重复写进 handoff', async () => {
  const { store, flowId, ctxs, cleanup } = await setup(['T-001']);
  try {
    const r = await flowAskArchitect(ctxs[0]!, { question: '分页参数叫什么？', kind: 'answer' });
    const c = r.details!['consult'] as string;
    await store.transitionTask(flowId, c, { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await store.transitionTask(flowId, c, { to: 'blocked', trigger: 'block', actor: 'dispatcher', facts: { reason: '测试' } });
    await answerAsUser(store, flowId, c, '用 page');
    const real = store.transitionTask.bind(store);
    store.transitionTask = (async (...a: Parameters<typeof real>) => {
      if (a[1] === 'T-001') { store.transitionTask = real; throw new Error('被杀'); }
      return real(...a);
    }) as typeof real;
    await assert.rejects(resolveConsults(store, flowId), /被杀/);
    assert.equal(store.readTask(flowId, 'T-001').blocked_by, 'architect', '还在等，下次调度会再恢复');
    await resolveConsults(store, flowId);
    assert.notEqual(store.readTask(flowId, 'T-001').blocked_by, 'architect');
    assert.equal(store.readHandoff(flowId, 'T-001').split(`架构师的回答（${c}）`).length, 2, '回答只出现一次');
  } finally { cleanup(); }
});
