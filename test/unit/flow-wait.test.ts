// forge_wait 指定 task_id 时，主会话问架构师的回答到了也立刻返回，不等那个任务变化或等到超时。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { flowWait } from '../../src/tools/orchestrator-tools.ts';
import type { Engine } from '../../src/core/engine/dispatcher.ts';
import { ANSWER_FILE } from '../../src/core/engine/consult.ts';
import { taskRel } from '../../src/core/state/state-store.ts';
import { setupProject } from '../helpers/project.ts';
import { mkTask } from '../helpers/tasks.ts';

test('forge_wait(task_id)：等待中主会话的问题有了回答，立刻返回回答', async () => {
  const p = await setupProject({ stages: ['S1'], tasks: [mkTask('T-001', { stage: 'S1' }), mkTask('T-002', { stage: 'S1', kind: 'consult', role: 'architect', writes: [], verify: [] })] });
  try {
    let answered = false;
    const engine = {
      autoDispatch: true,
      isIdle: () => false,
      activeRuns: () => [],
      postMergeRunning: () => false,
      // 第一次等待期间架构师回答了主会话的问题（T-002 完成并留下回答）
      waitForChange: async () => {
        if (answered) return;
        answered = true;
        const f = path.join(p.dir, '.forge', taskRel(p.flowId, 'T-002'));
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), status: 'done' }, null, 2));
        await p.store.saveEvidence(p.flowId, 'T-002', ANSWER_FILE, '用 page 与 size', 'architect');
      },
    } as unknown as Engine;
    const started = Date.now();
    const w = await flowWait(p.store, engine, { task_id: 'T-001', timeout_s: 30 }, p.config);
    assert.match(w.text, /架构师的回答（T-002）：\n用 page 与 size/);
    assert.ok(Date.now() - started < 10_000, '没有等到超时');
  } finally { p.cleanup(); }
});
