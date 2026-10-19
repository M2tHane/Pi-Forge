// 开始 build 流程前，把用户写好的 docs/PRD.md、docs/ARCHITECTURE.md 与 docs/prototype/ 原样提交到主分支（路径不变），集成分支从这个提交开出；不解析或改写内容。
// 它们在主工作区里有未提交的改动时也以主工作区为准：只提交这几个路径，不碰主工作区里的其他改动。
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StateStore } from '../state/state-store.ts';
import { isLightFlow } from '../state/schemas.ts';
import { git, gitOk } from '../state/git.ts';
import { isSensitive } from '../state/paths.ts';
import { IMAGE_MIME_TYPES } from '../workspace/forge-read.ts';
import { isUtf8 } from 'node:buffer';
import { ARCHITECTURE_PATH, PRD_PATH, PROTOTYPE_DIR } from './prd.ts';

/**
 * 独立索引提交原语：不改变任何工作区或主索引，内容和分支上一样时不提交（返回 null）。
 * replace：先删掉分支上这些路径（目录）下的文件，提交后它们只含 files；filters：按 .gitattributes 过滤（换行等），和 git add 一样。
 */
export function commitFilesToBranch(root: string, branch: string, files: readonly { rel: string; content: string | Buffer; mode?: '100644' | '100755' }[], message: string,
  opts: { replace?: readonly string[]; filters?: boolean } = {}): string | null {
  const ref = `refs/heads/${branch}`;
  const parent = git(root, ['rev-parse', ref]).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-intake-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(root, ['read-tree', parent], { env });
    if (opts.replace?.length) git(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...opts.replace.map((p) => `:(literal)${p}`)], { env });
    files.forEach((f, i) => {
      const file = path.join(dir, `content-${i}`);
      writeFileSync(file, f.content);
      // 默认原件不经过 .gitattributes 的换行或 clean 过滤器。
      const blob = git(root, ['hash-object', '-w', opts.filters ? `--path=${f.rel}` : '--no-filters', file]).trim();
      git(root, ['update-index', '--add', '--cacheinfo', `${f.mode ?? '100644'},${blob},${f.rel}`], { env });
    });
    const tree = git(root, ['write-tree'], { env }).trim();
    if (tree === git(root, ['rev-parse', `${parent}^{tree}`]).trim()) return null;
    const sha = git(root, ['commit-tree', tree, '-p', parent, '-m', message], { engineIdentity: true }).trim();
    git(root, ['update-ref', ref, sha, parent]);
    return sha;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export class IntakeError extends Error {}
export interface IntakeFile { path: string; size: number; type: string }
export interface PreparedIntake { files: IntakeFile[]; contents: { rel: string; content: Buffer; mode: '100644' | '100755' }[] }
const MAX_FILES = 500;
const MAX_BYTES = 30 * 1024 * 1024;
const INPUT_PATHS = [PRD_PATH, ARCHITECTURE_PATH, PROTOTYPE_DIR];

/** 读出 docs/PRD.md、docs/ARCHITECTURE.md 与 docs/prototype/ 下的全部文件（路径不变）；符号链接、敏感文件与超量输入直接报错 */
export function prepareInputs(root: string): PreparedIntake {
  const files: IntakeFile[] = [];
  const contents: PreparedIntake['contents'] = [];
  let bytes = 0;
  const visit = (rel: string): void => {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new IntakeError(`输入不能包含符号链接：${rel}。`);
    if (isSensitive(rel.toLowerCase())) throw new IntakeError(`禁止提交敏感文件：${rel}。`);
    if (st.isDirectory()) {
      // 原型目录可能是从别处拷来的仓库：.git 不是原型，git 也不接受路径里有 .git
      for (const name of readdirSync(abs).sort()) if (name !== '.DS_Store' && name !== '.git') visit(`${rel}/${name}`);
      return;
    }
    if (!st.isFile()) throw new IntakeError(`输入必须是普通文件或目录：${rel}。`);
    if (files.length >= MAX_FILES) throw new IntakeError(`输入超过 ${MAX_FILES} 个文件；请精简原型目录。`);
    bytes += st.size;
    if (bytes > MAX_BYTES) throw new IntakeError(`输入超过 ${MAX_BYTES / 1048576} MiB。`);
    const content = readFileSync(abs);
    const type = IMAGE_MIME_TYPES[path.extname(rel).toLowerCase()] ?? (isUtf8(content) && !content.includes(0) ? 'text' : 'binary');
    contents.push({ rel, content, mode: st.mode & 0o111 ? '100755' : '100644' });
    files.push({ path: rel, size: content.length, type });
  };
  for (const rel of INPUT_PATHS) visit(rel);
  return { files, contents };
}

/** 检出了这个分支的 worktree 目录（含主工作区） */
function checkedOutAt(root: string, ref: string): string[] {
  const dirs: string[] = [];
  let dir = '';
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (line === `branch ${ref}`) dirs.push(realpathSync(dir));
  }
  return dirs;
}

/**
 * 把 PRD、技术栈与原型提交到主分支：提交只含这几个路径（原型里删掉的文件也删掉），主分支上已经一样时不提交、返回 null。
 * 用独立索引提交，不跑项目的 git 钩子（钩子检查的是项目代码，还没有骨架时可能跑不起来）。主分支检出在主工作区时，
 * 提交后只把主索引里这几个路径换成新提交的内容，其他已暂存、未暂存的改动不受影响；检出在别的 worktree 时报错。
 */
export function commitInputsToMain(root: string, main: string, prepared: PreparedIntake): string | null {
  const ref = `refs/heads/${main}`;
  if (!gitOk(root, ['show-ref', '--verify', '--quiet', ref])) throw new IntakeError(`主分支 ${main} 不存在，请检查 workflow.yaml 的 main_branch`);
  const here = realpathSync(root);
  const at = checkedOutAt(root, ref);
  const other = at.find((d) => d !== here);
  if (other) throw new IntakeError(`主分支 ${main} 检出在另一个 worktree（${other}），程序不能往里提交 ${PRD_PATH}、${ARCHITECTURE_PATH} 与 ${PROTOTYPE_DIR}/。请在那里提交这几个路径，或在那里换到别的分支后再 /forge-build。`);
  const sha = commitFilesToBranch(root, main, prepared.contents, 'pi-forge: 提交 PRD、技术栈与原型', { replace: INPUT_PATHS, filters: true });
  if (sha && at.length) git(root, ['reset', '-q', sha, '--', ...INPUT_PATHS.map((p) => `:(literal)${p}`)]);
  return sha;
}

/** 记录这次流程用的输入清单（文件已经由 commitInputsToMain 提交到主分支，集成分支从那里开出） */
export async function importInputs(store: StateStore, flowId: string, prepared: PreparedIntake): Promise<IntakeFile[]> {
  const flow = store.readFlow(flowId);
  if (isLightFlow(flow)) throw new IntakeError('修复与小改动流程不接收 PRD。');
  const intake = { prd: PRD_PATH, prototype_path: PROTOTYPE_DIR, files: prepared.files };
  if (JSON.stringify(flow.intake) !== JSON.stringify(intake)) await store.setIntake(flowId, intake, 'human', `接收 PRD、技术栈与原型，共 ${prepared.files.length} 个文件`);
  return prepared.files;
}
