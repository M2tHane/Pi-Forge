// 合并队列：合并开始后出错时，集成分支是否已包含任务的提交决定转阻塞还是留给 /forge-resume 恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';
import { hashToken } from '../../src/core/state/state-machine.ts';
import { MergeQueue } from '../../src/core/engine/merge-queue.ts';
import { createTaskWorktree, snapshot } from '../../src/core/workspace/worktree.ts';
import { commitFilesToBranch } from '../../src/core/spec/intake.ts';

test('快进集成分支之后记状态失败：任务留在 merging、名额不放，/forge-resume 的恢复补成 done', async () => {
  const p = await setupProject({ tasks: [mkTask('T-001')] });
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    const wt = createTaskWorktree(p.dir, p.flowId, 'T-001', integ);
    mkdirSync(path.join(wt.path, 'src/server/t-001'), { recursive: true });
    writeFileSync(path.join(wt.path, 'src/server/t-001/a.ts'), 'export const a = 1;\n');
    snapshot(wt.path, '实现');
    const now = Date.now();
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'ready', trigger: 'schedule', actor: 'scheduler' });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'in_progress', trigger: 'dispatch', actor: 'dispatcher', patch: {
      lease: { run_id: 'r-1', role: 'worker', token_hash: hashToken('tok'), acquired_at: new Date(now).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() },
      worktree: wt.path, branch: wt.branch, base_sha: wt.base_sha } });
    await p.store.transitionTask(p.flowId, 'T-001', { to: 'queued_merge', trigger: 'submit', actor: 'run:r-1', facts: { token: 'tok', diff_files: ['src/server/t-001/a.ts'], review_required: false } });
    // 快进之后记 done 失败（拿不到 .forge 的锁、写状态提交失败等）
    const real = p.store.transitionTask.bind(p.store);
    p.store.transitionTask = (async (...a: Parameters<typeof real>) => { if (a[2].trigger === 'merge_done') throw new Error('拿不到 .forge 锁'); return real(...a); }) as typeof real;
    const mq = new MergeQueue(p.dir, p.store, p.config);
    await assert.rejects(mq.processNext(p.flowId), /拿不到 \.forge 锁/);
    p.store.transitionTask = real;
    assert.equal(p.git('show', `${integ}:src/server/t-001/a.ts`), 'export const a = 1;', '代码已进集成分支');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'merging');
    assert.equal(p.store.readMergeQueue().merging?.task, 'T-001');
    assert.equal(await mq.recoverInterrupted(p.flowId), 'done');
    assert.equal(p.store.readTask(p.flowId, 'T-001').status, 'done');
    assert.equal(p.store.readMergeQueue().merging, null);
  } finally { p.cleanup(); }
});

test('同步主分支：合并失败但没有冲突文件时停下交给用户，原因带上 git 的输出', async () => {
  const p = await setupProject({});
  try {
    commitFilesToBranch(p.dir, 'main', [{ rel: 'src/b.ts', content: 'export const b = 1;\n' }], '主分支上的改动');
    // 集成分支也有自己的提交，同步才需要真正合并
    commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'src/a.ts', content: 'export const a = 1;\n' }], '实现');
    writeFileSync(path.join(p.dir, '.git/hooks/prepare-commit-msg'), '#!/bin/sh\necho "钩子拒绝" >&2\nexit 1\n', { mode: 0o755 });
    const r = await new MergeQueue(p.dir, p.store, p.config).syncMain(p.flowId);
    assert.equal(r?.kind, 'conflict');
    const sync = p.store.readFlow(p.flowId).sync;
    assert.equal(sync?.status, 'conflict');
    assert.match(sync?.reason ?? '', /合并失败但没有冲突文件：.*钩子拒绝/);
  } finally { p.cleanup(); }
});
