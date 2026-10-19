import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStageFixTasks, groupIssuesByOwner, lastWorkerTask, ownerOf, testWritesOf } from '../../src/core/acceptance/stage-fix.ts';
import { setupProject } from '../helpers/project.ts';
import { S0_EXTRA_WRITES } from '../../src/core/plan/batches.ts';
import { ownAcceptanceGlob } from '../../src/core/state/paths.ts';
import { mkTask } from '../helpers/tasks.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskRel } from '../../src/core/state/state-store.ts';
import type { Project } from '../helpers/project.ts';

function force(p: Project, id: string, patch: Record<string, unknown>) {
  const f = path.join(p.dir, '.forge', taskRel(p.flowId, id));
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...patch }, null, 2));
}

import type { TaskFile } from '../../src/core/state/schemas.ts';
type T = Pick<TaskFile, 'id' | 'kind' | 'status' | 'writes' | 'for_task'>;
const t = (id: string, kind: string, status: string, writes: string[], for_task?: string) => ({ id, kind, status, writes, ...(for_task ? { for_task } : {}) }) as T;
const TASKS = [
  t('T-001', 'impl', 'done', ['src/a/**', 'src/shared.ts']),
  t('T-002', 'impl', 'done', ['src/b/**']),
  t('T-010', 'impl', 'done', ['src/shared.ts']),
  t('T-003', 'impl', 'in_progress', ['src/c/**']),
  t('T-001.fx-1', 'fix', 'done', ['src/a/x.ts'], 'T-001'),
  t('T-001.fx-2', 'fix', 'cancelled', ['src/a/x.ts'], 'T-001'),
];

test('ownerOf：取 writes 覆盖、已 done 的 impl 中编号最大的；未 done 与 fix 不算', () => {
  assert.equal(ownerOf('src/shared.ts', TASKS)?.id, 'T-010');
  assert.equal(ownerOf('src/a/x.ts', TASKS)?.id, 'T-001');
  assert.equal(ownerOf('src/c/y.ts', TASKS), undefined);
});

test('ownerOf：实际改过的文件（changed）也算归属；没有 architect 时找不到负责者的归兜底的 impl', () => {
  const changed = new Map([['T-002', ['src/server/main.ts']]]);
  assert.equal(ownerOf('src/server/main.ts', TASKS, changed)?.id, 'T-002');
  assert.equal(ownerOf('src/server/main.ts', TASKS), undefined);
  // 唯一归属：找不到负责者的文件也跟着这条问题交给它
  const one = groupIssuesByOwner([{ files: ['src/server/main.ts', 'src/c/y.ts'], text: '崩溃' }], TASKS, { changed, fallback: 'T-010' });
  assert.deepEqual([...one.groups.keys()], ['T-002']);
  assert.deepEqual([...one.groups.get('T-002')!.files], ['src/server/main.ts', 'src/c/y.ts']);
  const r = groupIssuesByOwner([{ files: ['src/c/y.ts'], text: '崩溃' }], TASKS, { changed, fallback: 'T-010' });
  assert.deepEqual([...r.groups.keys()], ['T-010']);
  assert.deepEqual(r.unowned, []);
  // 兜底必须是已 done 的 impl，否则仍算找不到
  assert.deepEqual(groupIssuesByOwner([{ files: ['src/c/y.ts'], text: 'x' }], TASKS, { fallback: 'T-001.fx-1' }).unowned, ['src/c/y.ts']);
});

// 批次流程：S0 的 architect（writes 同 plan-flow 生成的真实值，含 **）、两个 domain、前端基础与两个页面
const BATCH = [
  { ...t('T-001', 'impl', 'done', ['**', ...S0_EXTRA_WRITES, ownAcceptanceGlob('T-001')]), role: 'architect' },
  t('T-002', 'impl', 'done', ['src/server/user/**']),
  t('T-003', 'impl', 'done', ['src/server/catalog/**']),
  t('T-004', 'impl', 'done', []),
  { ...t('T-005', 'impl', 'done', []), pages: ['login'] },
  { ...t('T-006', 'impl', 'done', []), pages: ['purchase-orders'] },
];

test('ownerOf：先看实际改过的，再看 writes（plan 的 paths），最后页面文件归页面任务', () => {
  const changed = new Map([['T-004', ['src/web/pages/login/index.tsx', 'src/server/user/shared.ts']]]);
  // 实际改过的优先于 paths 与页面
  assert.equal(ownerOf('src/web/pages/login/index.tsx', BATCH, changed)?.id, 'T-004');
  assert.equal(ownerOf('src/server/user/shared.ts', BATCH, changed)?.id, 'T-004');
  assert.equal(ownerOf('src/server/user/service.ts', BATCH, changed)?.id, 'T-002');
  // 页面 id 是路径的一段或文件名（大小写、- 与 _ 不计）
  assert.equal(ownerOf('src/web/pages/login/form.tsx', BATCH)?.id, 'T-005');
  assert.equal(ownerOf('src/web/PurchaseOrders.tsx', BATCH)?.id, 'T-006');
  assert.equal(ownerOf('src/web/purchase_orders/list.vue', BATCH)?.id, 'T-006');
  assert.equal(ownerOf('src/web/loginx.tsx', BATCH), undefined);
  // architect 的 ** 不参与按 writes 匹配，只作为兜底
  assert.equal(ownerOf('README.md', BATCH), undefined);
  assert.equal(ownerOf('docs/plan.md', BATCH), undefined);
});

test('groupIssuesByOwner：一条问题只交给一个 task；唯一归属归它，涉及多个或找不到的整条交给 architect', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: ['src/server/user/a.ts', 'src/server/user/b.ts', 'README.md'], text: '只涉及 user' },
    { files: ['src/web/pages/login/index.tsx'], text: '登录页' },
    { files: ['src/server/user/a.ts', 'src/server/catalog/c.ts'], text: '跨 domain' },
    { files: ['README.md'], text: '找不到归属' },
    { files: [], text: '没写文件' },
  ], BATCH, { architect: 'T-001', fallback: 'T-006' });
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-002', 'T-005']);
  assert.deepEqual([...groups.get('T-002')!.files], ['src/server/user/a.ts', 'src/server/user/b.ts', 'README.md']);
  assert.deepEqual(groups.get('T-002')!.texts, ['只涉及 user']);
  assert.deepEqual(groups.get('T-005')!.texts, ['登录页']);
  assert.deepEqual(groups.get('T-001')!.texts, ['跨 domain', '找不到归属', '没写文件']);
  assert.deepEqual([...groups.get('T-001')!.files], ['src/server/user/a.ts', 'src/server/catalog/c.ts', 'README.md']);
  assert.deepEqual(unowned, []);
});

test('createStageFixTasks：多个归属的问题建一个 architect 的修复任务，接着 architect 的会话', async () => {
  const p = await setupProject({ tasks: [
    mkTask('T-001', { role: 'architect', writes: ['**', ...S0_EXTRA_WRITES, ownAcceptanceGlob('T-001')] }),
    mkTask('T-002', { role: 'backend', writes: ['src/server/user/**'] }), mkTask('T-003', { role: 'backend', writes: ['src/server/catalog/**'] }),
  ] });
  try {
    for (const id of ['T-001', 'T-002', 'T-003']) force(p, id, { status: 'done' });
    const r = await createStageFixTasks(p.store, p.flowId, 'qa', [
      { files: ['src/server/user/a.ts', 'src/server/catalog/b.ts'], text: '下单后库存没扣' },
      { files: ['src/server/user/a.ts'], text: '登录失败' },
    ], 'S1.qa 第 1 轮');
    assert.deepEqual(r.tasks.sort(), ['T-001.fx-1', 'T-002.fx-1']);
    const a = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.equal(a.role, 'architect');
    assert.equal(a.for_task, 'T-001');
    assert.equal(a.fork_from_task, 'T-001');
    assert.match(p.store.readHandoff(p.flowId, 'T-001.fx-1'), /交给你（架构师）修[\s\S]*下单后库存没扣/);
    assert.equal(p.store.readTask(p.flowId, 'T-002.fx-1').role, 'backend');
  } finally { p.cleanup(); }
});

test('lastWorkerTask：最近一个已 done 的 .fx-n，否则 impl 本身', () => {
  assert.equal(lastWorkerTask('T-001', TASKS), 'T-001.fx-1');
  assert.equal(lastWorkerTask('T-002', TASKS), 'T-002');
});

test('groupIssuesByOwner：没有 architect 时跨 task 的问题按文件拆开，找不到负责者的单列', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: ['src/a/x.ts', 'src/b/y.ts'], text: '问题一' },
    { files: ['src/a/z.ts'], text: '问题二' },
    { files: ['docs/x.md'], text: '问题三' },
  ], TASKS);
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-002']);
  assert.deepEqual([...groups.get('T-001')!.files], ['src/a/x.ts', 'src/a/z.ts']);
  assert.deepEqual(groups.get('T-001')!.texts, ['问题一', '问题二']);
  assert.deepEqual(groups.get('T-002')!.texts, ['问题一']);
  assert.deepEqual(unowned, ['docs/x.md']);
});

test('groupIssuesByOwner：指定 owner 的问题跳过 ownerOf，可写范围用 writes；owner 不是 impl 时归入 unowned', () => {
  const { groups, unowned } = groupIssuesByOwner([
    { files: [], text: '验收测试失败', owner: 'T-003', writes: ['src/c/**'] },
    { files: ['tests/x.ts'], text: '别的', owner: 'T-999' },
    { files: ['src/a/x.ts'], text: '普通' },
  ], [...TASKS, t('T-003', 'impl', 'done', ['src/c/**'])]);
  assert.deepEqual([...groups.keys()].sort(), ['T-001', 'T-003']);
  assert.deepEqual([...groups.get('T-003')!.files], ['src/c/**']);
  assert.deepEqual(unowned, ['tests/x.ts']);
});

test('groupIssuesByOwner：候选负责者（验收目录的 task）和文件归属一起算；唯一时带上它的 writes，没有 architect 时各自一组', () => {
  const tasks = [...TASKS, t('T-003', 'impl', 'done', ['src/c/**'])];
  const one = groupIssuesByOwner([{ files: ['src/c/x.ts'], text: '验收失败', candidates: ['T-003'] }], tasks, { architect: 'T-001' });
  assert.deepEqual([...one.groups.keys()], ['T-003']);
  assert.deepEqual([...one.groups.get('T-003')!.files], ['src/c/x.ts', 'src/c/**']);
  const two = groupIssuesByOwner([{ files: ['src/b/y.ts'], text: '验收失败', candidates: ['T-003'] }], tasks, { architect: 'T-001' });
  assert.deepEqual([...two.groups.keys()], ['T-001']);
  assert.deepEqual([...two.groups.get('T-001')!.files], ['src/b/y.ts']);
  const legacy = groupIssuesByOwner([{ files: ['src/b/y.ts'], text: '验收失败', candidates: ['T-003', 'T-404'] }], tasks);
  assert.deepEqual([...legacy.groups.keys()].sort(), ['T-002', 'T-003']);
  assert.deepEqual([...legacy.groups.get('T-003')!.files], ['src/c/**']);
});

test('testWritesOf：带上非验收测试的 glob；tests/acceptance/** 不带，只保留 impl 自己的验收目录（test_author: false）', () => {
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**', 'tests/unit/a/**', 'tests/e2e/**', 'tests/contract/**', 'tests/acceptance/T-001/x/**', 'tests/acceptance/**', 'docs/x.md'] }),
    ['tests/unit/a/**', 'tests/e2e/**', 'tests/contract/**']);
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**', 'tests/acceptance/T-001/**', 'tests/acceptance/T-002/**'] }), ['tests/acceptance/T-001/**']);
  assert.deepEqual(testWritesOf({ id: 'T-001', writes: ['src/a/**'] }), []);
});

test('createStageFixTasks：fix 的 writes = 问题文件 + 原 impl 的非验收测试 glob；原 task 没有测试 glob 时不加；记录 source_round', async () => {
  const p = await setupProject({ tasks: [
    mkTask('T-001', { writes: ['src/a/**', 'tests/unit/a/**', 'tests/acceptance/T-001/**'] }), mkTask('T-002', { writes: ['src/b/**'] }),
  ] });
  try {
    const r = await createStageFixTasks(p.store, p.flowId, 'qa', [
      { files: ['src/a/x.ts'], text: '问题 A', owner: 'T-001' }, { files: ['src/b/y.ts'], text: '问题 B', owner: 'T-002' },
    ], 'S1.qa 第 1 轮', 'engine', { task: 'S1.qa', round: 1 });
    assert.deepEqual(r.tasks, ['T-001.fx-1', 'T-002.fx-1']);
    const a = p.store.readTask(p.flowId, 'T-001.fx-1');
    assert.deepEqual(a.writes, ['src/a/x.ts', 'tests/unit/a/**', 'tests/acceptance/T-001/**']);
    assert.deepEqual(a.source_round, { task: 'S1.qa', round: 1 });
    assert.deepEqual(p.store.readTask(p.flowId, 'T-002.fx-1').writes, ['src/b/y.ts']);
  } finally { p.cleanup(); }
});

test('domainOwner：该 domain 在本阶段最近完成的后端任务，本阶段没有就往前面的阶段找', async () => {
  const { domainOwner } = await import('../../src/core/acceptance/stage-fix.ts');
  const b = (id: string, stage: string, domain: string, status = 'done', kind = 'impl', role = 'backend') => ({ id, stage, domain, status, kind, role }) as Pick<TaskFile, 'id' | 'kind' | 'status' | 'role' | 'stage' | 'domain'>;
  const tasks = [b('T-002', 'S1', 'user'), b('T-003', 'S1', 'catalog'), b('T-008', 'S2', 'user'), b('T-009', 'S2', 'catalog', 'in_progress'),
    b('T-010', 'S2', 'catalog', 'done', 'fix'), b('T-011', 'S2', 'catalog', 'done', 'impl', 'frontend')];
  const stages = ['S0', 'S1', 'S2', 'S3'];
  assert.equal(domainOwner('user', tasks, stages, 'S2')?.id, 'T-008', '本阶段有就用本阶段的');
  assert.equal(domainOwner('catalog', tasks, stages, 'S2')?.id, 'T-003', '本阶段的没完成、fix 与前端任务不算：往前找');
  assert.equal(domainOwner('user', tasks, stages, 'S1')?.id, 'T-002', '不看后面的阶段');
  assert.equal(domainOwner('user', tasks, stages, 'S3')?.id, 'T-008');
  assert.equal(domainOwner('nope', tasks, stages, 'S2'), undefined);
});

// stage-qa 写的归属（owner）：S0 的 architect；S1 的 user、catalog 两个 domain 与前端；S2 的 user 还没做完
const st = (id: string, status: string, stage: string, extra: Record<string, unknown>) => ({ ...t(id, 'impl', status, []), stage, ...extra });
const CLAIM = [
  { ...st('T-001', 'done', 'S0', { role: 'architect' }), writes: ['**', ...S0_EXTRA_WRITES, ownAcceptanceGlob('T-001')] },
  { ...st('T-002', 'done', 'S1', { role: 'backend', domain: 'user' }), writes: ['src/server/user/**'] },
  { ...st('T-003', 'done', 'S1', { role: 'backend', domain: 'catalog' }), writes: ['src/server/catalog/**'] },
  st('T-004', 'done', 'S1', { role: 'frontend' }),
  st('T-005', 'done', 'S1', { role: 'frontend', pages: ['login'] }),
  st('T-006', 'done', 'S1', { role: 'frontend' }),
  { ...st('T-007', 'in_progress', 'S2', { role: 'backend', domain: 'user' }), writes: ['src/server/user/**'] },
  st('T-008', 'done', 'S2', { role: 'frontend', pages: ['orders'] }),
];
const claimTo = (claim: string | undefined, files: string[], stage: string) =>
  [...groupIssuesByOwner([{ files, text: 'x', ...(claim ? { claim } : {}) }], CLAIM, { architect: 'T-001', stage, stages: ['S0', 'S1', 'S2'] }).groups.keys()];

test('stage-qa 的 owner：domain 名交给该 domain 最近完成的后端任务（本阶段没有就往前找），优先于文件归属', () => {
  assert.deepEqual(claimTo('catalog', ['src/web/pages/login/form.tsx'], 'S1'), ['T-003']);
  assert.deepEqual(claimTo('user', ['src/server/user/a.ts'], 'S2'), ['T-002']);
});

test('stage-qa 的 owner：frontend 先在前端任务里按文件找，找不到或有多个时交给本批的页面任务', () => {
  assert.deepEqual(claimTo('frontend', ['src/web/pages/login/form.tsx'], 'S1'), ['T-005']);
  assert.deepEqual(claimTo('frontend', ['README.md'], 'S2'), ['T-008']);
  assert.deepEqual(claimTo('frontend', [], 'S1'), ['T-005']);
});

test('stage-qa 的 owner：unknown、没写、不存在的 domain 按文件归属，找不到时交给架构师', () => {
  assert.deepEqual(claimTo('unknown', ['src/server/user/a.ts'], 'S1'), ['T-002']);
  assert.deepEqual(claimTo(undefined, ['src/server/catalog/c.ts'], 'S1'), ['T-003']);
  assert.deepEqual(claimTo('ghost', ['src/server/catalog/c.ts'], 'S1'), ['T-003']);
  assert.deepEqual(claimTo('ghost', ['README.md'], 'S1'), ['T-001']);
});
