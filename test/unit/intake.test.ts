// 入库 docs/PRD.md、docs/ARCHITECTURE.md 与 docs/prototype/、开始前的输入检查，不依赖真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitInputsToMain, importInputs, prepareInputs } from '../../src/core/spec/intake.ts';
import { buildInputProblems } from '../../src/core/spec/preflight.ts';
import { setupProject } from '../helpers/project.ts';

const write = (root: string, rel: string, content: string | Buffer) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const show = (root: string, ref: string, rel: string) => execFileSync('git', ['show', `refs/heads/${ref}:${rel}`], { cwd: root });

test('buildInputProblems：缺 PRD、缺技术栈、缺原型目录、原型里没有 .html、缺 DESIGN.md 或 theme.css 时分别提示；齐全时为空', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-inputs-'));
  const problems = () => buildInputProblems(dir);
  try {
    assert.deepEqual(problems().map((p) => p.split('：')[0]), ['缺少 docs/PRD.md', '缺少 docs/ARCHITECTURE.md', '缺少 docs/prototype/']);
    write(dir, 'docs/PRD.md', '# PRD');
    write(dir, 'docs/ARCHITECTURE.md', '# 技术栈\n- Node.js 22\n');
    write(dir, 'docs/prototype/README.md', '说明');
    assert.deepEqual(problems().map((p) => p.split('：')[0]), ['docs/prototype/ 里没有 .html 文件', '缺少 docs/prototype/DESIGN.md、docs/prototype/theme.css']);
    write(dir, 'docs/prototype/pages/list.html', '<title>列表</title>');
    write(dir, 'docs/prototype/DESIGN.md', '# 设计');
    assert.deepEqual(problems().map((p) => p.split('：')[0]), ['缺少 docs/prototype/theme.css']);
    write(dir, 'docs/prototype/theme.css', ':root {}');
    assert.deepEqual(problems(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PRD 与原型提交到主分支：只含这两个路径，路径、类型、可执行权限不变，换行按 .gitattributes 处理，主工作区随后是干净的', async () => {
  const p = await setupProject({ files: { '.gitattributes': '*.md text eol=lf\n' } });
  try {
    const image = Buffer.from([0, 255, 1, 2, 3]);
    write(p.dir, 'docs/PRD.md', '# 中文 PRD\r\n正文\r\n');
    write(p.dir, 'docs/ARCHITECTURE.md', '# 技术栈\n');
    write(p.dir, 'docs/prototype/index.html', '<title>首页</title>');
    write(p.dir, 'docs/prototype/img/logo.png', image);
    write(p.dir, 'docs/prototype/assets/app.js', 'console.log(1)');
    write(p.dir, 'docs/prototype/.DS_Store', 'x');
    write(p.dir, 'docs/other.md', '不入库');
    chmodSync(path.join(p.dir, 'docs/prototype/assets/app.js'), 0o755);
    const prepared = prepareInputs(p.dir);
    const before = p.git('rev-parse', 'main');
    const sha = commitInputsToMain(p.dir, 'main', prepared);
    assert.ok(sha);
    assert.equal(p.git('rev-parse', 'main'), sha);
    assert.equal(p.git('rev-parse', `${sha}^`), before);
    assert.deepEqual(p.git('diff', '--name-only', before, sha).split('\n'), ['docs/ARCHITECTURE.md', 'docs/PRD.md', 'docs/prototype/assets/app.js', 'docs/prototype/img/logo.png', 'docs/prototype/index.html']);
    assert.deepEqual(prepared.files.map((f) => [f.path, f.type]), [
      ['docs/PRD.md', 'text'], ['docs/ARCHITECTURE.md', 'text'], ['docs/prototype/assets/app.js', 'text'], ['docs/prototype/img/logo.png', 'image/png'], ['docs/prototype/index.html', 'text'],
    ]);
    assert.equal(show(p.dir, 'main', 'docs/PRD.md').toString(), '# 中文 PRD\n正文\n', '和 git add 一样按 eol=lf 转换');
    assert.deepEqual(show(p.dir, 'main', 'docs/prototype/img/logo.png'), image);
    assert.match(p.git('ls-tree', 'main', '--', 'docs/prototype/assets/app.js'), /^100755/);
    assert.equal(p.git('status', '--porcelain', '-uall', '--', 'docs'), '?? docs/other.md\n?? docs/prototype/.DS_Store');
    const files = await importInputs(p.store, p.flowId, prepared);
    assert.deepEqual(p.store.readFlow(p.flowId).intake?.files.map((f) => f.path), files.map((f) => f.path));
  } finally { p.cleanup(); }
});

test('PRD 与原型提交到主分支：主工作区里其他已暂存、未暂存的改动不变；再次执行不产生新提交；原型里删掉的文件在主分支上也删掉', async () => {
  const p = await setupProject();
  try {
    write(p.dir, 'docs/PRD.md', 'PRD');
    write(p.dir, 'docs/ARCHITECTURE.md', '技术栈');
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    write(p.dir, 'docs/prototype/old.html', '<p>old</p>');
    assert.ok(commitInputsToMain(p.dir, 'main', prepareInputs(p.dir)));
    write(p.dir, 'staged.txt', '已暂存');
    p.git('add', 'staged.txt');
    write(p.dir, 'README.md', '主工作区修改');
    write(p.dir, 'docs/PRD.md', 'PRD v2');
    p.git('add', 'docs/PRD.md');
    write(p.dir, 'docs/PRD.md', 'PRD v3');
    rmSync(path.join(p.dir, 'docs/prototype/old.html'));
    const others = () => [p.git('diff', '--cached', '--', '.', ':(exclude)docs'), p.git('diff', '--', '.', ':(exclude)docs'), p.git('status', '--porcelain', '--', '.', ':(exclude)docs')];
    const before = others();
    const sha = commitInputsToMain(p.dir, 'main', prepareInputs(p.dir));
    assert.ok(sha);
    assert.equal(p.git('show', 'main:docs/PRD.md'), 'PRD v3', '以主工作区为准');
    assert.equal(p.git('ls-tree', '--name-only', 'main', 'docs/prototype/'), 'docs/prototype/a.html');
    assert.deepEqual(others(), before);
    assert.equal(p.git('status', '--porcelain', '--', 'docs'), '');
    assert.equal(p.git('branch', '--show-current'), 'main');
    assert.equal(commitInputsToMain(p.dir, 'main', prepareInputs(p.dir)), null);
    assert.equal(p.git('rev-parse', 'main'), sha);
  } finally { p.cleanup(); }
});

test('PRD 与原型提交到主分支：主分支没检出时直接提交、主工作区不动；检出在别的 worktree 时报错', async () => {
  const p = await setupProject();
  const other = mkdtempSync(path.join(tmpdir(), 'forge-main-wt-'));
  try {
    write(p.dir, 'docs/PRD.md', 'PRD');
    write(p.dir, 'docs/ARCHITECTURE.md', '技术栈');
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    p.git('switch', '-q', '-c', 'feature');
    const status = p.git('status', '--porcelain');
    const sha = commitInputsToMain(p.dir, 'main', prepareInputs(p.dir));
    assert.equal(p.git('rev-parse', 'main'), sha);
    assert.equal(p.git('show', 'main:docs/PRD.md'), 'PRD');
    assert.equal(p.git('status', '--porcelain'), status);
    assert.equal(p.git('branch', '--show-current'), 'feature');
    rmSync(other, { recursive: true });
    p.git('worktree', 'add', '-q', other, 'main');
    write(p.dir, 'docs/PRD.md', 'PRD v2');
    assert.throws(() => commitInputsToMain(p.dir, 'main', prepareInputs(p.dir)), /主分支 main 检出在另一个 worktree/);
    assert.equal(p.git('rev-parse', 'main'), sha);
  } finally { p.git('worktree', 'remove', '--force', other); p.cleanup(); }
});

test('prepareInputs 拒绝符号链接、敏感文件与超限目录', async () => {
  const p = await setupProject();
  const outside = mkdtempSync(path.join(tmpdir(), 'forge-input-'));
  try {
    write(outside, 'prd.md', '仓库外 PRD');
    write(p.dir, 'docs/ARCHITECTURE.md', '技术栈');
    symlinkSync(path.join(outside, 'prd.md'), path.join(p.dir, 'docs/PRD.md'));
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    assert.throws(() => prepareInputs(p.dir), /符号链接/);
    rmSync(path.join(p.dir, 'docs/PRD.md'));
    write(p.dir, 'docs/PRD.md', 'PRD');
    symlinkSync('..', path.join(p.dir, 'docs/prototype/loop'));
    assert.throws(() => prepareInputs(p.dir), /符号链接/);
    rmSync(path.join(p.dir, 'docs/prototype/loop'));
    // 测试只有占位内容，不使用任何密钥。
    write(p.dir, 'docs/prototype/.env.test', '占位');
    assert.throws(() => prepareInputs(p.dir), /敏感文件/);
    rmSync(path.join(p.dir, 'docs/prototype/.env.test'));
    for (let i = 0; i < 500; i++) write(p.dir, `docs/prototype/many/${i}.txt`, 'a');
    assert.throws(() => prepareInputs(p.dir), /超过 500 个/);
    rmSync(path.join(p.dir, 'docs/prototype/many'), { recursive: true });
    write(p.dir, 'docs/prototype/large.bin', Buffer.alloc(30 * 1024 * 1024 + 1));
    assert.throws(() => prepareInputs(p.dir), /超过 30 MiB/);
  } finally { p.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('原型目录里的 .git（目录或文件）跳过，PRD 与原型照常提交到主分支', async () => {
  const p = await setupProject();
  try {
    write(p.dir, 'docs/PRD.md', 'PRD');
    write(p.dir, 'docs/ARCHITECTURE.md', '技术栈');
    write(p.dir, 'docs/prototype/a.html', '<p>a</p>');
    execFileSync('git', ['init', '-q'], { cwd: path.join(p.dir, 'docs/prototype') });
    write(p.dir, 'docs/prototype/sub/.git', 'gitdir: ../elsewhere');
    const prepared = prepareInputs(p.dir);
    assert.deepEqual(prepared.files.map((f) => f.path), ['docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/prototype/a.html']);
    assert.ok(commitInputsToMain(p.dir, 'main', prepared));
    assert.deepEqual(p.git('ls-tree', '-r', '--name-only', 'main', '--', 'docs').split('\n'), ['docs/ARCHITECTURE.md', 'docs/PRD.md', 'docs/prototype/a.html']);
  } finally { p.cleanup(); }
});
