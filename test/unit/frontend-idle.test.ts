// /forge-status --metrics 的前端空等：前端 run 之间没有前端 run 在跑的时间，归到空等之后开始的前端任务所在阶段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontendIdle, renderFrontendIdle } from '../../src/core/ops/status-detail.ts';
import type { TaskStatus } from '../../src/core/state/schemas.ts';

const T0 = Date.parse('2026-03-04T01:00:00Z');
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const run = (task: string, from: number, to: number | null, role = 'frontend') => ({ role, task, started_at: at(from), ended_at: to === null ? null : at(to) });
const task = (id: string, stage: string, status: TaskStatus = 'done', role = 'frontend') => ({ id, stage, role, status });

test('前端空等：只算前端 run 之间的空档，重叠的 run 不重复算，后端 run 不算；归到之后开始的任务的阶段', () => {
  const tasks = [task('T-003', 'S1'), task('T-004', 'S1'), task('T-007', 'S2'), task('T-001', 'S1', 'done', 'backend')];
  const runs = [run('T-003', 0, 10), run('T-004', 15, 30), run('T-004', 20, 25), run('T-001', 30, 60, 'backend'), run('T-007', 70, 80)];
  assert.deepEqual(frontendIdle(runs, tasks, T0 + 100 * 60_000), { idle_ms: 45 * 60_000, gaps: 2, by_stage: [{ stage: 'S1', idle_ms: 5 * 60_000 }, { stage: 'S2', idle_ms: 40 * 60_000 }], ongoing_ms: 0 });
  // 还有前端任务没结束、现在没有前端 run 在跑：上一个 run 结束到现在是进行中的空等
  const ongoing = frontendIdle(runs, [...tasks, task('T-010', 'S3', 'pending')], T0 + 100 * 60_000)!;
  assert.equal(ongoing.ongoing_ms, 20 * 60_000);
  assert.match(renderFrontendIdle(ongoing), /## 前端空等\n- 共 45 分钟（2 段）；按空等之后开始的前端任务所在阶段：S1 5 分钟、S2 40 分钟；现在还在空等 20 分钟\n- 口径：/);
  // 前端 run 还在跑：没有进行中的空等
  assert.equal(frontendIdle([...runs, run('T-010', 90, null)], [...tasks, task('T-010', 'S3', 'in_progress')], T0 + 100 * 60_000)!.ongoing_ms, 0);
  assert.equal(frontendIdle([run('T-001', 0, 5, 'backend')], tasks, T0), null);
});
