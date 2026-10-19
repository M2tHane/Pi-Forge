// 合入主分支：S0 批准时的 publishSkeleton 与最后阶段的批准都可以重试。
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProject } from '../helpers/project.ts';
import { commitFilesToBranch } from '../../src/core/spec/intake.ts';
import { mergeToMain, publishSkeleton } from '../../src/core/stage/release.ts';
import { approveStage } from '../../src/core/stage/stages.ts';

test('publishSkeleton：上次合入主分支成功、移动集成分支之前失败，重试时直接把集成分支移到主分支', async () => {
  const p = await setupProject({ stages: ['S0'] });
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    commitFilesToBranch(p.dir, integ, [{ rel: 'docs/plan.md', content: '# 计划\n' }], '架构');
    const merged = await mergeToMain(p.dir, p.store, p.config, p.flowId);
    assert.notEqual(p.git('rev-parse', integ), merged, '模拟合入后、update-ref 之前中断');
    assert.equal(await publishSkeleton(p.dir, p.store, p.config, p.flowId), merged);
    assert.equal(p.git('rev-parse', integ), merged);
    assert.equal(p.git('rev-parse', 'main'), merged, '没有再合入一次');
  } finally { p.cleanup(); }
});

test('最后阶段的批准：上次合入主分支成功、批准之前失败，重试时不再合入，直接批准并结束流程', async () => {
  const p = await setupProject({ stages: ['S1'] });
  try {
    const integ = p.store.readFlow(p.flowId).integration_branch;
    commitFilesToBranch(p.dir, integ, [{ rel: 'src/a.ts', content: 'export const a = 1;\n' }], '实现');
    await p.store.transitionStage(p.flowId, { to: 'awaiting_gate', trigger: 'submit_gate', actor: 'engine' });
    await p.store.transitionStage(p.flowId, { to: 'awaiting_human', trigger: 'gate_passed', actor: 'engine', needs_human: true });
    const merged = await mergeToMain(p.dir, p.store, p.config, p.flowId);
    const out = await approveStage({ root: p.dir, store: p.store, config: p.config }, p.flowId);
    assert.match(out, /已经包含在 main 中，不再合入[\s\S]*已批准阶段 S1/);
    assert.equal(p.git('rev-parse', 'main'), merged, '没有再合入一次');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'done');
  } finally { p.cleanup(); }
});

test('主工作区改了 PRD 没提交时不合入；"留给以后"的说明按阶段写：S0 之后各批读新版本，最后交付不按它修改', async () => {
  for (const [stage, text] of [['S0', /架构不按它返工，但批准后各批读的是新版本/], ['S1', /这次交付不按它修改/]] as const) {
    const p = await setupProject({ stages: [stage], files: { 'docs/PRD.md': '# PRD\n' } });
    try {
      commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'src/a.ts', content: 'export const a = 1;\n' }], '实现');
      writeFileSync(path.join(p.dir, 'docs/PRD.md'), '# PRD\n改过\n');
      await assert.rejects(mergeToMain(p.dir, p.store, p.config, p.flowId), text);
    } finally { p.cleanup(); }
  }
});

test('主工作区改了 docs/ARCHITECTURE.md 没提交时同样不合入，报错写明这个路径', async () => {
  const p = await setupProject({ stages: ['S1'], files: { 'docs/ARCHITECTURE.md': '# 技术栈\n' } });
  try {
    commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'src/a.ts', content: 'export const a = 1;\n' }], '实现');
    writeFileSync(path.join(p.dir, 'docs/ARCHITECTURE.md'), '# 技术栈\n改过\n');
    await assert.rejects(mergeToMain(p.dir, p.store, p.config, p.flowId), /需求输入在流程开始后改过（没有提交）：docs\/ARCHITECTURE\.md/);
  } finally { p.cleanup(); }
});

/** 在测试仓库里放一个总是失败的 git 钩子 */
function failingHook(dir: string, name: string): void {
  writeFileSync(path.join(dir, '.git/hooks', name), `#!/bin/sh\necho "钩子 ${name} 拒绝" >&2\nexit 1\n`, { mode: 0o755 });
}

test('合入主分支不跑项目的 commit-msg、pre-merge-commit 钩子；--no-verify 跳不过的钩子失败时报 git 的输出，不说冲突', async () => {
  const p = await setupProject({ stages: ['S1'] });
  try {
    commitFilesToBranch(p.dir, p.store.readFlow(p.flowId).integration_branch, [{ rel: 'src/a.ts', content: 'export const a = 1;\n' }], '实现');
    failingHook(p.dir, 'prepare-commit-msg');
    await assert.rejects(mergeToMain(p.dir, p.store, p.config, p.flowId), (e: Error) => {
      assert.match(e.message, /合入 main 失败（没有冲突文件）：.*钩子 prepare-commit-msg 拒绝/);
      assert.doesNotMatch(e.message, /冲突：|主分支在流程期间被修改过/);
      return true;
    });
    rmSync(path.join(p.dir, '.git/hooks/prepare-commit-msg'));
    failingHook(p.dir, 'commit-msg');
    failingHook(p.dir, 'pre-merge-commit');
    const merged = await mergeToMain(p.dir, p.store, p.config, p.flowId);
    assert.equal(p.git('rev-parse', 'main'), merged);
  } finally { p.cleanup(); }
});
