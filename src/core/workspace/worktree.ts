// worktree 与任务分支：从集成分支 HEAD 拉出，放在项目目录之外的同级目录。
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dirtyFiles, git, gitOk } from '../state/git.ts';
import { matchesAny } from '../state/paths.ts';
import { runShell, type CommandRun } from './verify-runner.ts';

export const worktreesRoot = (mainRoot: string) =>
  path.join(path.dirname(path.resolve(mainRoot)), `${path.basename(path.resolve(mainRoot))}.worktrees`);
export const taskBranch = (flow: string, task: string) => `flow/${flow}/${task}`;
export const worktreePath = (mainRoot: string, flow: string, task: string) => path.join(worktreesRoot(mainRoot), `${flow}-${task}`);

/** 每个 run 的临时目录：在项目与 worktree 之外，agent 可以在其中随意建、删文件做实验；run 结束后删除 */
export const scratchDir = (mainRoot: string, run: string) => path.join(worktreesRoot(mainRoot), '.scratch', run);

export const headSha = (dir: string, ref = 'HEAD') => git(dir, ['rev-parse', ref]).trim();
export const branchExists = (root: string, branch: string) => gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);

/** 集成分支不存在时从 from（提交或分支）创建；返回其 HEAD。 */
export function ensureIntegrationBranch(root: string, branch: string, from: string): string {
  if (!branchExists(root, branch)) git(root, ['branch', branch, from]);
  return headSha(root, branch);
}

export interface TaskWorktree { path: string; branch: string; base_sha: string }

/**
 * 建立任务 worktree；已存在（例如重新派发）时复用。
 * from 默认是集成分支；承载先行验收测试的任务从测试分支末端开工（base_sha 即测试分支末端，测试不计入本任务的 diff）。
 */
export function createTaskWorktree(root: string, flow: string, task: string, integrationBranch: string, from = integrationBranch): TaskWorktree {
  const wt = worktreePath(root, flow, task);
  const branch = taskBranch(flow, task);
  if (existsSync(path.join(wt, '.git'))) {
    return { path: wt, branch, base_sha: git(wt, ['merge-base', 'HEAD', from]).trim() };
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  const base = headSha(root, from);
  if (branchExists(root, branch)) git(root, ['worktree', 'add', '-q', wt, branch]);
  else git(root, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  return { path: wt, branch, base_sha: base };
}

/** 把 worktree 的全部改动（含未跟踪文件）提交为快照；无改动返回 null。 */
export function snapshot(wt: string, message: string): string | null {
  git(wt, ['add', '-A']);
  if (gitOk(wt, ['diff', '--cached', '--quiet'])) return null;
  git(wt, ['commit', '-q', '--no-verify', '-m', message], { engineIdentity: true });
  return headSha(wt);
}

/**
 * 提交前清理工作区中未被 git 跟踪、又不在任务 writes 内的文件（测试或程序运行留下的数据文件、日志等）。
 * 它们不是任务的产出，留着会让提交因越界被拒，而实施者又无权删除。返回被删除的文件（相对 worktree）。
 */
export function cleanStrayUntracked(wt: string, writes: readonly string[] | ((f: string) => boolean)): string[] {
  const untracked = git(wt, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const keep = typeof writes === 'function' ? writes : (f: string) => matchesAny(f, writes);
  const stray = untracked.filter((f) => !keep(f));
  for (const f of stray) rmSync(path.join(wt, f), { force: true });
  return stray.sort();
}

/** base 到 HEAD 之间改动的文件（不合并重命名，删除也算）。调用前应先 snapshot。 */
export function changedFiles(wt: string, base: string): string[] {
  return git(wt, ['diff', '--name-only', '--no-renames', `${base}`, 'HEAD']).split('\n').filter(Boolean).sort();
}

export function isClean(wt: string): boolean {
  return git(wt, ['status', '--porcelain']).trim() === '';
}

export function removeWorktree(root: string, wt: string, branch?: string): void {
  if (existsSync(wt)) git(root, ['worktree', 'remove', '--force', wt]);
  git(root, ['worktree', 'prune']);
  if (branch && branchExists(root, branch)) git(root, ['branch', '-D', branch]);
}

/** 插件在工作目录中生成的产物（codegraph 索引、playwright-browser 的快照与日志），不应进入任务快照 */
export const TOOL_ARTIFACTS = ['.codegraph/', '.playwright-cli/'];
/** 每个 worktree 各自生成的环境与缓存（uv 的 .venv、Python 字节码与测试缓存）：项目的 .gitignore 漏写时也不进入任务快照 */
export const ENV_ARTIFACTS = ['.venv/', '__pycache__/', '.pytest_cache/'];

/**
 * 写入仓库本地的 info/exclude（不被跟踪，所有 worktree 共享），避免插件产物与各 worktree 的环境出现在任务 diff 中被判越界。
 */
export function ensureLocalExcludes(root: string, patterns: readonly string[] = [...TOOL_ARTIFACTS, ...ENV_ARTIFACTS]): void {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const file = path.join(path.isAbsolute(common) ? common : path.join(root, common), 'info', 'exclude');
  mkdirSync(path.dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = patterns.filter((p) => !cur.split('\n').includes(p));
  if (missing.length) appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# pi-forge：插件产物、环境与项目命令生成的文件不进入任务快照\n${missing.join('\n')}\n`);
}

/** git status 的条目（排除 .forge）；all 为 false 时整个未跟踪的目录只算一条（`dir/`） */
const statusEntries = (root: string, all: boolean, spec = '.') =>
  git(root, ['status', '--porcelain', ...(all ? ['-uall'] : []), '--', spec, ':(exclude).forge']).split('\n').filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), file: l.slice(3) }));

/**
 * 在主工作区执行项目命令（S0 门禁的 install 与 env_up、建共享环境时的 env_up），执行完收拾它新弄脏的文件：
 * S0 返工与交付都要把集成分支合入主分支，主工作区有未提交的改动就合不进去。只比较执行前后的 git status，不认语言与目录名：
 * 改了的受跟踪文件（install 改写的锁文件等）还原成提交的版本；新出现的未跟踪文件与目录（依赖、构建产物、容器挂载的数据目录）
 * 写进本地 exclude，不删。执行前就有的改动不碰，免得动到用户自己的文件。返回还原了哪些文件。
 */
export async function runInMainWorkspace(root: string, command: string, timeoutMs?: number, env?: Record<string, string>): Promise<Omit<CommandRun, 'command'> & { restored: string[] }> {
  const before = dirtyFiles(root);
  const r = await runShell(command, root, timeoutMs, env);
  const restored: string[] = [];
  const excluded: string[] = [];
  for (const { code, file } of statusEntries(root, false)) {
    if (code === '??' && file.endsWith('/') && [...before].some((b) => b.startsWith(file))) {
      // 目录里有执行前就有的未跟踪文件：只忽略新出现的，原有的照样看得见、能提交
      excluded.push(...statusEntries(root, true, file).map((e) => e.file).filter((f) => !before.has(f)));
    } else if (before.has(file)) continue;
    else if (code === '??') excluded.push(file);
    // 只还原改在工作区、没有暂存的；暂存了的留着，合入主分支时会报出来
    else if (code[0] === ' ') restored.push(file);
  }
  if (restored.length) git(root, ['checkout', '--', ...restored], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  if (excluded.length) ensureLocalExcludes(root, excluded.map((f) => `/${f.replace(/[*?[\\]/g, '\\$&')}`));
  return { ...r, restored };
}
