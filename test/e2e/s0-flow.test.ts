// 架构阶段 S0：architect 由 fake-subagent 扮演，经真实的 SubagentRuntime（guard + forge_* 工具）提交；
// 提交时检查必需文件与 docs/plan.md → 审查（在架构师的分支上跑全量测试）→ 合并 → 门禁合入主分支、在主工作区 install 与 env_up
// → 用户验收、批准 → 按计划生成批次阶段与任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupProject } from '../helpers/project.ts';
import { runFlowBuild, runFlowCommand } from '../../src/commands/forge.ts';
import { nextStep } from '../../src/core/engine/context-injector.ts';
import { renderStatus } from '../../src/core/ops/status-view.ts';
import { statusText } from '../../src/tools/orchestrator-tools.ts';
import type { FakeAgent } from '../fixtures/fake-subagent/launcher.ts';
import { commandEnv, engineEnv } from '../helpers/commands.ts';
import { ALL_FAKE, makeEngine } from '../helpers/engine.ts';
import { ARCH_FILES, PLAN_MD_TEXT } from '../helpers/arch.ts';

/** PRD、技术栈与原型在流程开始时已入库 */
const INPUTS: Record<string, string> = { ...Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => k.startsWith('docs/PRD') || k.startsWith('docs/prototype/'))), 'docs/ARCHITECTURE.md': '# 技术栈\nNode + SQLite。\n', 'docs/prototype/DESIGN.md': '# 设计\n', 'docs/prototype/theme.css': ':root {}\n' };
const OUTPUTS = Object.fromEntries(Object.entries(ARCH_FILES).filter(([k]) => !(k in INPUTS)));

async function writeAll(a: FakeAgent, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const r = await a.call('write', { path: rel, content });
    assert.ok(r.ok, `${rel}：${r.text}`);
  }
}

test('S0：缺必需文件时提交被退回 → 补齐后提交 → 审查者在架构师的分支上跑全量测试 → 门禁合入主分支、在主工作区 install 与 env_up → 批准页 → 批准后生成批次阶段与任务', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'forge-s0-')), 'cmd.log');
  // 架构师写的命令：审查者按它跑测试，门禁按它在主工作区装依赖、起服务
  const commands = `commands:\n  test: "echo test >> ${log}"\n  acceptance: "echo acceptance >> ${log}"\n  install: "echo install $(pwd -P) >> ${log}"\n  env_up: "echo env_up $(pwd -P) >> ${log}"\n`;
  const submits: { ok: boolean; text: string }[] = [];
  let architectRuns = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    if (role === 'architect') {
      architectRuns++;
      await a.call('forge_claim');
      const { 'docs/arch/domains.md': _domains, ...partial } = OUTPUTS;
      await writeAll(a, { ...partial, 'commands.yaml': commands, 'rules/backend.md': '- 调用别的 domain 只经接口\n', 'tests/acceptance/S0-smoke/smoke.test.ts': '// 冒烟\n' });
      submits.push(await a.call('forge_submit', { summary: '架构' }));
      await writeAll(a, { 'docs/arch/domains.md': OUTPUTS['docs/arch/domains.md']! });
      await a.call('forge_note', { text: '架构已完成' });
      submits.push(await a.call('forge_submit', { summary: '架构' }));
      return;
    }
    if (role === 'backend' || role === 'frontend') { await a.call('forge_claim'); await a.call('forge_block', { reason: '测试到此为止' }); return; }
    throw new Error(`意外的角色 ${role}`);
  });
  try {
    await e.engine.pump(p.flowId);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    assert.equal(architectRuns, 1);
    assert.equal(submits[0]!.ok, false);
    assert.match(submits[0]!.text, /架构产出还不能提交（1 处）[\s\S]*- 缺少 docs\/arch\/domains\.md/);
    assert.equal(submits[1]!.ok, true, submits[1]!.text);
    const arch = p.store.readTask(p.flowId, 'T-001');
    assert.deepEqual([arch.kind, arch.role, arch.stage, arch.status], ['impl', 'architect', 'S0', 'done']);
    assert.equal(p.store.readTask(p.flowId, 'T-001.rv').status, 'done', '架构产出经过审查');
    // 集成分支上还没有架构师的 commands.yaml：审查者拿到的是架构师分支上的全量 test 与 acceptance
    assert.match(p.store.readHandoff(p.flowId, 'T-001.rv'), new RegExp(`在架构师的分支上运行全量测试与验收测试[\\s\\S]*- test：\`echo test >> ${log}\`\n- acceptance：\`echo acceptance >> ${log}\``));
    // 门禁：合入主分支后在主工作区执行 install 与 env_up；用户在主工作区验收
    const root = realpathSync(p.dir);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`install ${root}`, `env_up ${root}`]);
    assert.equal(p.git('show', 'main:docs/plan.md'), OUTPUTS['docs/plan.md']!.trim(), '等验收时架构产出已在主分支上');
    assert.equal(p.git('rev-parse', p.store.readFlow(p.flowId).integration_branch), p.git('rev-parse', 'main'), '集成分支移到合入后的提交');
    const merged = p.git('rev-parse', 'main');
    const flow = p.store.readFlow(p.flowId);
    assert.deepEqual([flow.stage, flow.stage_status], ['S0', 'awaiting_human']);
    assert.ok(!p.store.listTasks(p.flowId).some((t) => t.kind === 'qa'), '架构阶段不做浏览器验收');
    // 批准页：说明部分、风险与假设、提醒
    const step = nextStep(p.store, 3, 0, p.config);
    assert.equal(step.tool, 'none');
    assert.match(step.next, /\/forge-approve[\s\S]*2 个批次[\s\S]*## 风险与假设\n- 采购单不设审批/);
    assert.match(step.next, /docs\/plan\.md 的说明部分[\s\S]*Node \+ SQLite/);
    assert.doesNotMatch(statusText(p.store, null, p.flowId), /docs\/plan\.md 的说明部分/, '批准页只随每轮的下一步注入一份');
    assert.match(renderStatus(p.store, p.config), /架构产出已合入主分支，等你在主工作区验收后批准/);

    const out = await runFlowCommand('approve', e.cmd);
    assert.match(out, /架构产出在 main 上[\s\S]*已生成 2 个批次阶段（S1、S2）与 10 个 task[\s\S]*进入阶段 S1/);
    assert.equal(p.git('rev-parse', 'main'), merged, '批准时不再合入');
    const after = p.store.readFlow(p.flowId);
    assert.deepEqual(after.stages, ['S0', 'S1', 'S2']);
    assert.deepEqual(after.s_stages!.map((s) => [s.id, s.goal, s.exit]), [['S1', 'B1 基础资料', ['REQ-001', 'REQ-002']], ['S2', 'B2 单据', ['REQ-003']]]);
    assert.equal(after.stage, 'S1');
    assert.equal(p.git('show', 'main:docs/plan.md'), OUTPUTS['docs/plan.md']!.trim(), '架构产出合入了主分支');
    assert.equal(p.git('show', 'main:rules/backend.md'), '- 调用别的 domain 只经接口');
    const titles = p.store.listTasks(p.flowId).filter((t) => t.stage !== 'S0').map((t) => `${t.id} ${t.stage} ${t.title}`);
    assert.deepEqual(titles, [
      'T-002 S1 后端 user', 'T-003 S1 后端 catalog', 'T-004 S1 后端 inventory', 'T-005 S1 前端基础', 'T-006 S1 页面（B1）', 'T-007 S1 接入真实接口（B1）',
      'T-008 S2 后端 purchase', 'T-009 S2 页面（B2）', 'T-010 S2 接入真实接口（B2）', 'T-011 S2 收尾整理',
    ]);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-004').depends_on.map((d) => d.task), ['T-003']);
    assert.deepEqual(p.store.readTask(p.flowId, 'T-007').depends_on.map((d) => d.task), ['T-002', 'T-003', 'T-004', 'T-006']);
    assert.equal(p.store.readTask(p.flowId, 'T-007').fork_from_task, 'T-006');
    assert.equal(after.max_parallel_backend, 2, 'plan.md 的 max_parallel_backend 记在流程上');
    // 第 1 批开工：后端按 plan.md 的 max_parallel_backend=2 并行（user、catalog；inventory 等 catalog），前端只派前端基础
    await e.engine.idle();
    const launched = e.launcher.launched.filter((s) => ['backend', 'frontend'].includes(s.env['PI_FORGE_ROLE']!)).map((s) => `${s.env['PI_FORGE_TASK']} ${s.env['PI_FORGE_ROLE']}`);
    assert.deepEqual(launched.sort(), ['T-002 backend', 'T-003 backend', 'T-005 frontend']);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});

test('S0 打回：新建 architect task 接着上一个的会话，意见写进 handoff；返工后再次等待批准', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  let run = 0;
  const e = engineEnv(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    run++;
    await writeAll(a, run === 1 ? OUTPUTS : { 'docs/arch/domains.md': '# domain\n- user、catalog、inventory、purchase（inventory 并入 catalog 之后）\n' });
    await a.call('forge_note', { text: `第 ${run} 次` });
    assert.ok((await a.call('forge_submit', { summary: '架构' })).ok);
  });
  try {
    await e.engine.pump(p.flowId);
    await e.engine.idle();
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    // S0 还没有批次：/forge report 给批准页，不是交付汇报
    const report = await runFlowCommand('report', e.cmd);
    assert.match(report, /^计划：[\s\S]*架构产出已合入主分支[\s\S]*批准后按计划生成/);
    assert.doesNotMatch(report, /交付汇报/);
    assert.match(await runFlowCommand('reject "inventory 要等 catalog 做完"', e.cmd), /architect 返工（能接着原会话时接着/);
    await e.engine.idle();
    assert.deepEqual(e.errors, []);
    const t2 = p.store.readTask(p.flowId, 'T-002');
    assert.deepEqual([t2.kind, t2.role, t2.stage, t2.fork_from_task, t2.status], ['impl', 'architect', 'S0', 'T-001', 'done']);
    assert.match(p.store.readHandoff(p.flowId, 'T-002'), /需要返工[\s\S]*用户打回：inventory 要等 catalog 做完/);
    assert.ok(p.store.readEvents().some((ev) => ev.type === 'stage_reopened'));
    assert.equal(p.store.readFlow(p.flowId).plan_rework, undefined);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.match(p.git('show', 'main:docs/arch/domains.md'), /inventory 并入 catalog 之后/, '返工合入后再合入主分支一次');
  } finally { p.cleanup(); }
});

test('S0 的门禁合入主分支失败（主工作区有未提交的改动）：记事件、自动重试，处理后合入、等验收；打回返工后再合入一次，批准落地的是新计划', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  const onePlan = PLAN_MD_TEXT.replace(/ {2}- id: B2[\s\S]*?(?=shared:)/, '').replace('reqs: [REQ-001, REQ-002]', 'reqs: [REQ-001, REQ-002, REQ-003]');
  let run = 0;
  const { engine, errors } = makeEngine(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    run++;
    await writeAll(a, run === 1 ? OUTPUTS : { 'docs/plan.md': onePlan });
    await a.call('forge_note', { text: `第 ${run} 次` });
    assert.ok((await a.call('forge_submit', { summary: '架构' })).ok);
  }, ALL_FAKE, undefined, { gateRetryMs: [60_000] });
  const cmd = commandEnv(p, engine);
  const gateErrors = () => p.store.readEvents().filter((ev) => ev.data?.['kind'] === 'gate_error');
  try {
    writeFileSync(path.join(p.dir, 'scratch.txt'), '草稿');
    await engine.pump(p.flowId);
    await engine.idle();
    assert.equal(gateErrors().length, 1);
    assert.match(gateErrors()[0]!.reason ?? '', /主工作区有未提交的改动[\s\S]*scratch\.txt[\s\S]*自动重试/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
    assert.throws(() => p.git('show', 'main:docs/plan.md'), '合入失败时主分支不变');
    // 等重试期间的推进不重跑；处理后 /forge gate 立即重跑
    await engine.pump(p.flowId);
    await engine.idle();
    assert.equal(gateErrors().length, 1);
    rmSync(path.join(p.dir, 'scratch.txt'));
    assert.match(await runFlowCommand('gate', cmd), /等你在主工作区验收后批准/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(p.git('show', 'main:docs/plan.md'), OUTPUTS['docs/plan.md']!.trim());
    assert.equal(errors.length, 1, '出错的那次报给 onError');
    await runFlowCommand('reject "B2 并进 B1，只要一个批次"', cmd);
    await engine.idle();
    assert.equal(errors.length, 1);
    assert.equal(run, 2, '打回后派了架构师返工');
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_human');
    assert.equal(p.git('show', 'main:docs/plan.md'), onePlan.trim(), '返工合入后再合入主分支');
    const out = await runFlowCommand('approve', cmd);
    assert.match(out, /架构产出在 main 上[\s\S]*已生成 1 个批次阶段（S1）/);
    const after = p.store.readFlow(p.flowId);
    assert.deepEqual([after.stages, after.stage], [['S0', 'S1'], 'S1']);
    assert.ok((await p.store.verifyIntegrity()).ok);
  } finally { p.cleanup(); }
});

test('PRD、技术栈与原型没提交就 /forge-build：主分支上多一个只含这几个路径的提交，主工作区里其他改动不受影响；提交之后 S0 能合入主分支', async () => {
  const p = await setupProject({ stages: ['S0'] });
  const m = makeEngine(p, async (role, _nth, a) => {
    assert.equal(role, 'architect');
    await a.call('forge_claim');
    await writeAll(a, OUTPUTS);
    await a.call('forge_note', { text: '架构' });
    assert.ok((await a.call('forge_submit', { summary: '架构' })).ok);
  }, ALL_FAKE, undefined, { gateRetryMs: [60_000] });
  const e = { ...m, cmd: commandEnv(p, m.engine) };
  try {
    await p.store.transitionStage(p.flowId, { to: 'aborted', trigger: 'abort', actor: 'human' });
    for (const [rel, content] of Object.entries(INPUTS)) { mkdirSync(path.dirname(path.join(p.dir, rel)), { recursive: true }); writeFileSync(path.join(p.dir, rel), content); }
    writeFileSync(path.join(p.dir, 'staged.txt'), '已暂存');
    p.git('add', 'staged.txt');
    writeFileSync(path.join(p.dir, 'README.md'), '没暂存的修改');
    const before = p.git('rev-parse', 'main');
    const others = () => [p.git('diff', '--cached'), p.git('diff'), p.git('status', '--porcelain', '--', '.', ':(exclude)docs')];
    const dirty = others();
    assert.match(await runFlowBuild('', e.cmd), /已把 docs\/PRD\.md、docs\/ARCHITECTURE\.md 与 docs\/prototype\/ 提交到 main（[0-9a-f]{8}，共 7 个文件/);
    const flowId = p.store.readState().active_flow!;
    const integ = p.store.readFlow(flowId).integration_branch;
    assert.equal(p.git('rev-parse', 'main^'), before);
    assert.deepEqual(p.git('diff', '--name-only', before, 'main').split('\n'), Object.keys(INPUTS).sort());
    // /forge-build 之后程序直接派了架构师，集成分支可能已经往前走了：看流程的基线
    assert.equal(p.store.readFlow(flowId).base_sha, p.git('rev-parse', 'main'), '集成分支从这个提交开出');
    p.git('merge-base', '--is-ancestor', 'main', integ);
    assert.deepEqual(others(), dirty, '其他已暂存、未暂存的改动不变');
    assert.equal(p.git('status', '--porcelain', '--', 'docs'), '', 'PRD 与原型已入库');
    // 用户自己提交了其他改动；PRD 与原型已入库，主工作区是干净的，S0 能合入（提交之前门禁已经跑过的，合入因主工作区不干净出错，重跑一次）
    p.git('commit', '-q', '-am', '用户的改动');
    await e.engine.rerunGate(flowId);
    await e.engine.idle();
    assert.ok(e.errors.every((x) => /主工作区有未提交的改动/.test((x as Error).message)), String(e.errors));
    assert.equal(p.store.readFlow(flowId).stage_status, 'awaiting_human');
    assert.match(await runFlowCommand('approve', e.cmd), /架构产出在 main 上[\s\S]*进入阶段 S1/);
    assert.equal(p.git('show', 'main:docs/plan.md'), OUTPUTS['docs/plan.md']!.trim());
    assert.equal(p.git('show', 'main:staged.txt'), '已暂存');
  } finally { p.cleanup(); }
});

test('流程开始后用户又改了 PRD、加了原型文件：S0 的门禁不合入主分支，事件里写明是哪些路径、流程用的是开始时的版本、怎么处理', async () => {
  const p = await setupProject({ stages: ['S0'], files: INPUTS });
  const { engine } = makeEngine(p, async (_role, _nth, a) => {
    await a.call('forge_claim');
    await writeAll(a, OUTPUTS);
    await a.call('forge_note', { text: '架构' });
    assert.ok((await a.call('forge_submit', { summary: '架构' })).ok);
  }, ALL_FAKE, undefined, { gateRetryMs: [60_000] });
  try {
    writeFileSync(path.join(p.dir, 'docs/PRD.md'), `${INPUTS['docs/PRD.md']}\n### 新需求 REQ-005\n`);
    writeFileSync(path.join(p.dir, 'docs/prototype/report.html'), '<title>报表</title>');
    await engine.pump(p.flowId);
    await engine.idle();
    const ev = p.store.readEvents().find((x) => x.data?.['kind'] === 'gate_error');
    assert.match(ev?.reason ?? '', /docs\/PRD\.md、docs\/prototype\/report\.html[\s\S]*开始时提交到 main 的版本[\s\S]*撤销[\s\S]*自动重试[\s\S]*\/forge sync[\s\S]*\/forge-reject/);
    assert.equal(p.store.readFlow(p.flowId).stage_status, 'awaiting_gate');
  } finally { p.cleanup(); }
});
