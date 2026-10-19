import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createTaskWorktree, ensureIntegrationBranch, snapshot, changedFiles, isClean, removeWorktree, runInMainWorkspace, worktreesRoot } from '../../src/core/workspace/worktree.ts';
import { dirtyFiles } from '../../src/core/state/git.ts';
import { tmpRepo } from '../helpers/repo.ts';

function setup() {
  const repo = tmpRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'x');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  const cleanup = () => { rmSync(worktreesRoot(repo.dir), { recursive: true, force: true }); repo.cleanup(); };
  return { ...repo, cleanup };
}

test('从集成分支建 worktree，快照与 diff，复用与清理', () => {
  const { dir, git, cleanup } = setup();
  try {
    const intSha = ensureIntegrationBranch(dir, 'flow/B-001/integration', 'main');
    assert.equal(ensureIntegrationBranch(dir, 'flow/B-001/integration', 'main'), intSha);
    const wt = createTaskWorktree(dir, 'B-001', 'T-001', 'flow/B-001/integration');
    assert.equal(wt.base_sha, intSha);
    assert.equal(wt.branch, 'flow/B-001/T-001');
    assert.ok(wt.path.startsWith(worktreesRoot(dir)));
    assert.ok(!wt.path.startsWith(dir + path.sep), 'worktree 必须在项目目录之外');
    assert.ok(isClean(wt.path));

    mkdirSync(path.join(wt.path, 'src/server'), { recursive: true });
    writeFileSync(path.join(wt.path, 'src/server/a.ts'), 'a');
    writeFileSync(path.join(wt.path, 'README.md'), 'changed');
    assert.ok(!isClean(wt.path));
    assert.ok(snapshot(wt.path, 'wip'));
    assert.equal(snapshot(wt.path, 'wip'), null);
    assert.deepEqual(changedFiles(wt.path, wt.base_sha), ['README.md', 'src/server/a.ts']);
    // 主工作区不受影响
    assert.ok(!existsSync(path.join(dir, 'src/server/a.ts')));

    const again = createTaskWorktree(dir, 'B-001', 'T-001', 'flow/B-001/integration');
    assert.equal(again.path, wt.path);
    assert.equal(again.base_sha, wt.base_sha);

    removeWorktree(dir, wt.path, wt.branch);
    assert.ok(!existsSync(wt.path));
    assert.equal(git('branch', '--list', 'flow/B-001/T-001'), '');
  } finally { cleanup(); }
});

import { ensureLocalExcludes } from '../../src/core/workspace/worktree.ts';

test('插件产物与 .venv 等环境写入 info/exclude，不进入任务快照；重复执行不重复写入', () => {
  const { dir, git, cleanup } = setup();
  try {
    ensureLocalExcludes(dir);
    ensureLocalExcludes(dir);
    const ex = readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
    assert.equal(ex.split('\n').filter((l) => l === '.codegraph/').length, 1);
    ensureIntegrationBranch(dir, 'flow/B-001/integration', 'main');
    const wt = createTaskWorktree(dir, 'B-001', 'T-001', 'flow/B-001/integration');
    mkdirSync(path.join(wt.path, '.codegraph'));
    writeFileSync(path.join(wt.path, '.codegraph/codegraph.db'), 'x');
    mkdirSync(path.join(wt.path, '.venv/bin'), { recursive: true });
    writeFileSync(path.join(wt.path, '.venv/bin/python'), 'x');
    mkdirSync(path.join(wt.path, 'pkg/__pycache__'), { recursive: true });
    writeFileSync(path.join(wt.path, 'pkg/__pycache__/a.pyc'), 'x');
    writeFileSync(path.join(wt.path, 'a.ts'), 'a');
    snapshot(wt.path, 'wip');
    assert.deepEqual(changedFiles(wt.path, wt.base_sha), ['a.ts']);
    void git;
  } finally { cleanup(); }
});

test('在主工作区执行命令：新改的受跟踪文件还原，新出现的未跟踪文件与目录写进本地 exclude，执行前就有的改动不碰', async () => {
  const { dir, git, cleanup } = setup();
  try {
    writeFileSync(path.join(dir, 'uv.lock'), 'v1\n');
    writeFileSync(path.join(dir, 'Cargo.lock'), 'v1\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'lock');
    // 用户自己的改动：改了受跟踪的文件、新建了文件，还有一个文件放在命令之后也会写的目录里
    writeFileSync(path.join(dir, 'notes.txt'), 'mine\n');
    writeFileSync(path.join(dir, 'draft.md'), 'mine\n');
    mkdirSync(path.join(dir, 'data'));
    writeFileSync(path.join(dir, 'data/mine.txt'), 'mine\n');
    const before = dirtyFiles(dir);

    // Python 与 Rust 的锁文件被改写，虚拟环境、构建目录、容器挂载的数据目录、生成的配置文件
    const r = await runInMainWorkspace(dir, [
      'echo v2 > uv.lock', 'rm Cargo.lock', 'echo more >> notes.txt',
      'mkdir -p .venv/lib target/debug data/pg', 'touch .venv/lib/a.py target/debug/app data/pg/base .env.local',
    ].join(' && '));
    assert.equal(r.exit_code, 0);
    assert.deepEqual(r.restored.sort(), ['Cargo.lock', 'uv.lock']);
    assert.equal(readFileSync(path.join(dir, 'uv.lock'), 'utf8'), 'v1\n');
    assert.ok(existsSync(path.join(dir, 'Cargo.lock')));
    assert.equal(readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine\nmore\n', '执行前就改了的文件不还原');
    assert.deepEqual(dirtyFiles(dir), before, '只剩执行前就有的改动');
    assert.ok(existsSync(path.join(dir, 'target/debug/app')), '新文件只忽略，不删');
    const exclude = readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').split('\n');
    for (const p of ['/.venv/', '/target/', '/.env.local', '/data/pg/base']) assert.ok(exclude.includes(p), `exclude 里应有 ${p}`);
    assert.ok(!exclude.includes('/data/'), '目录里有用户的文件时不整个忽略');
  } finally { cleanup(); }
});
