// 接入真实接口时前端不改后端：forge_submit 的 backend_issues 按 domain 交给该 domain 的后端任务修（找不到的交给架构师），
// 修复建在本阶段，批次门禁等它们修完；后端审查材料带本 domain 的接口；前端改到后端 domain 范围内的文件只提醒、记事件，不拦。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject, PROJECT_YAML } from '../helpers/project.ts';
import { drive, engineEnv, submitWork, writeFiles } from '../helpers/commands.ts';
import type { TaskInput } from '../../src/core/state/state-store.ts';
import type { TaskFile } from '../../src/core/state/schemas.ts';

const hard = (task: string): TaskFile['depends_on'][number] => ({ task, type: 'hard', reason: '接入真实接口要等本批都完成' });
const mk = (id: string, role: string, title: string, writes: string[], extra: Partial<TaskInput> = {}): TaskInput => ({
  id, stage: 'S1', kind: 'impl', role, title, scopes: ['code'], depends_on: [], inputs: [], writes: [...writes, `tests/acceptance/${id}/**`], verify: [], ...extra,
});
const TASKS: TaskInput[] = [
  mk('T-001', 'architect', '公共内容', ['**']),
  mk('T-002', 'backend', '后端 user', ['src/server/user/**'], { domain: 'user', layers: ['backend'] }),
  mk('T-003', 'frontend', '页面 login', [], { page: 'login', layers: ['frontend'] }),
  mk('T-004', 'frontend', '接入真实接口（B1）', [], { layers: ['frontend'], review: 'skip', fork_from_task: 'T-003', depends_on: ['T-001', 'T-002', 'T-003'].map(hard) }),
];

test('接入真实接口：backend_issues 交给对应 domain 的后端修（不存在的 domain 交给架构师），批次门禁等修复完成', async () => {
  const p = await setupProject({ yaml: PROJECT_YAML.replace(/^  test: .*$/m, '  test: "true"'), stages: ['S1'], tasks: TASKS,
    files: { 'docs/contracts/openapi.yaml': 'openapi: 3.1.0\npaths:\n  /api/users/me:\n    get: { operationId: me }\n  /api/products:\n    get: { operationId: products }\n' } });
  const flow = () => p.store.readFlow(p.flowId);
  const gateEvents = () => p.store.readEvents().filter((e) => e.flow === p.flowId && e.type === 'gate_result');
  let submitText = '';
  const handoffs: Record<string, string> = {};
  const atFix: Record<string, { status: string; gates: number }> = {};
  const e = engineEnv(p, async (role, _nth, a) => {
    await a.call('forge_claim');
    const id = a.env.task;
    if (role === 'reviewer') { handoffs[id] = p.store.readHandoff(p.flowId, id); return; }
    if (id.includes('.fx-')) {
      handoffs[id] = p.store.readHandoff(p.flowId, id);
      atFix[id] = { status: flow().stage_status, gates: gateEvents().length };
      return submitWork(a, `修复 ${id}`, { [`src/fix/${id.toLowerCase()}.ts`]: `export const fixed = '${id}';\n` });
    }
    if (id === 'T-004') {
      // 顺手改了后端 domain 范围内的文件：只提醒
      await writeFiles(a, { 'src/web/api.ts': 'export const api = 1;\n', 'src/server/user/patch.ts': 'export const patched = 1;\n' });
      await a.call('forge_note', { text: '接入完成' });
      const r = await a.call('forge_submit', { summary: '接入真实接口', backend_issues: [
        { domain: 'user', problem: 'GET /api/users/me 返回 name，openapi.yaml 写的是 displayName' },
        { domain: 'ghost', problem: 'POST /api/ghost 返回 404' },
      ] });
      assert.ok(r.ok, r.text);
      submitText = r.text;
      return;
    }
    if (role === 'architect' || role === 'backend' || role === 'frontend') return submitWork(a, `${id} 完成`, { [`src/${id.toLowerCase()}/index.ts`]: `export const id = '${id}';\n` });
    throw new Error(`意外的任务 ${id}（${role}）`);
  });
  try {
    await drive(e, p.flowId, 40);
    assert.deepEqual(e.errors, []);
    // 每个 domain 一个修复：user 交给 T-002（接着它的会话、可写范围是 domain 的 paths），ghost 交给架构师
    const fixes = p.store.listTasks(p.flowId).filter((t) => t.kind === 'fix');
    assert.deepEqual(fixes.map((t) => [t.id, t.role, t.stage, t.for_task, t.fork_from_task, t.status]),
      [['T-001.fx-1', 'architect', 'S1', 'T-001', 'T-001', 'done'], ['T-002.fx-1', 'backend', 'S1', 'T-002', 'T-002', 'done']]);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-002.fx-1').writes, ['src/server/user/**', 'tests/acceptance/T-002/**']);
    assert.match(handoffs['T-002.fx-1']!, /接入真实接口发现的问题[\s\S]*T-004[\s\S]*displayName[\s\S]*以 openapi\.yaml 为准/);
    assert.doesNotMatch(handoffs['T-002.fx-1']!, /ghost/);
    assert.match(handoffs['T-001.fx-1']!, /交给你（架构师）修[\s\S]*domain「ghost」（没找到这个 domain 完成的后端任务）/);
    assert.match(submitText, /修复任务 T-002\.fx-1、T-001\.fx-1/);
    // 修复运行时门禁还没跑；修复都合入后才跑门禁，之后等签收
    for (const id of ['T-001.fx-1', 'T-002.fx-1']) assert.deepEqual(atFix[id], { status: 'active', gates: 0 }, id);
    const events = p.store.readEvents().filter((ev) => ev.flow === p.flowId);
    const lastFixMerge = events.findLastIndex((ev) => ev.type === 'merge' && ev.task?.includes('.fx-'));
    assert.ok(lastFixMerge >= 0 && events.findIndex((ev) => ev.type === 'gate_result') > lastFixMerge, '门禁在修复合入之后');
    assert.equal(flow().stage_status, 'awaiting_human');
    // 后端 domain 的审查材料带上 openapi.yaml 里本 domain 的接口
    assert.match(handoffs['T-002.rv']!, /## 相关契约\n### docs\/contracts\/openapi\.yaml 里 domain「user」负责的接口\n```\npaths:\n  \/api\/users\/me:\n    get:\n      operationId: me\n```/);
    assert.doesNotMatch(handoffs['T-002.rv']!, /operationId: products/);
    // 提醒：提交结果与事件各一条，不影响提交
    assert.match(submitText, /提醒（不影响这次提交）：这些文件在后端 domain 的范围内：src\/server\/user\/patch\.ts（user）/);
    const edit = events.find((ev) => ev.type === 'note' && ev.data?.['frontend_backend_edit']);
    assert.deepEqual(edit?.data?.['frontend_backend_edit'], [{ file: 'src/server/user/patch.ts', domain: 'user' }]);
    assert.equal(edit?.task, 'T-004');
    const issued = events.find((ev) => ev.type === 'note' && ev.data?.['backend_issues']);
    assert.deepEqual(issued?.data, { backend_issues: 2, domains: ['user', 'ghost'], fixes: ['T-002.fx-1', 'T-001.fx-1'] });
  } finally { p.cleanup(); }
});
