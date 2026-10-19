// /forge-init：还不是 git 仓库时 git init（主分支名取 workflow.yaml 的 main_branch）、运行 preflight、生成骨架、示例放进 docs/examples/、.gitignore 补上 .codegraph/ 与 docs/examples/、
// 初始化 .forge/、做一次初始提交；显式执行时还建立代码索引（codegraph init）。
// 可重复执行：不覆盖已有文件，只补缺，并报告与模板不同的文件。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../state/state-store.ts';
import { git, gitOk } from '../state/git.ts';
import { preflight, type PreflightItem } from '../spec/preflight.ts';
import { codegraphIndexed } from './codegraph.ts';

export interface InitReport {
  /** git 初始化的结果（一行）：新建了仓库，或已是仓库、跳过 */
  git: string;
  created: string[];
  existing: string[];
  differs: string[];
  commit: string | null;
  preflight: PreflightItem[];
  /** 建立代码索引的结果（一行）；没有要求建索引或已有索引时为 null */
  index: string | null;
}

/**
 * 示例 PRD、技术栈与原型（含 DESIGN.md、theme.css）：只复制到工作目录、写进 .gitignore、不提交。
 * 进了 git 就会出现在每个任务的 worktree 里，agent 可能把示例需求当成本项目的需求。
 */
export const EXAMPLES_DIR = 'docs/examples/';

export function skeleton(packageRoot: string, projectName: string): Map<string, string> {
  const t = (rel: string) => readFileSync(path.join(packageRoot, rel), 'utf8');
  const files = new Map<string, string>();
  files.set('workflow.yaml', t('templates/workflow.yaml').replace(/^project: .*$/m, `project: ${projectName}`));
  files.set('commands.yaml', t('templates/commands.yaml'));
  files.set('AGENTS.md', t('templates/AGENTS.md'));
  // 通用规则；项目专属规则 rules/project.md 由规划阶段的主 agent 起草、用户批准时写入
  for (const f of readdirSync(path.join(packageRoot, 'rules')).filter((x) => x.endsWith('.md')).sort()) files.set(`rules/${f}`, t(`rules/${f}`));
  // docs/PRD.md、docs/ARCHITECTURE.md 与 docs/prototype/ 由用户照示例自己建：不生成空模板，/forge-build 查它们在不在就知道写没写
  files.set(`${EXAMPLES_DIR}PRD.md`, t('templates/examples/PRD.md'));
  files.set(`${EXAMPLES_DIR}ARCHITECTURE.md`, t('templates/examples/ARCHITECTURE.md'));
  for (const f of readdirSync(path.join(packageRoot, 'templates/examples/prototype')).sort()) {
    files.set(`${EXAMPLES_DIR}prototype/${f}`, t(`templates/examples/prototype/${f}`));
  }
  for (const dir of ['docs/contracts', 'docs/arch', 'tests/acceptance']) files.set(`${dir}/.gitkeep`, '');
  return files;
}

/** 用户自己改写的文件：和模板不同是正常的，不报告 */
const USER_OWNED = new Set(['workflow.yaml']);

/** buildIndex：建立代码索引并返回一行结果；只有显式的 /forge-init 传入（自动初始化时不建，避免 /forge-build 意外等很久） */
export async function initProject(
  root: string,
  packageRoot: string,
  deps?: { piVersion: string; packageRoots: string[] },
  buildIndex?: (root: string) => Promise<string>,
): Promise<InitReport> {
  let gitLine = '已是 git 仓库，跳过 git init';
  if (!gitOk(root, ['rev-parse', '--git-dir'])) {
    const main = mainBranchFor(root, packageRoot);
    git(root, ['init', '-q']);
    // 不用 git init -b：2.28 之前的 git 没有这个参数
    git(root, ['symbolic-ref', 'HEAD', `refs/heads/${main}`]);
    gitLine = `已执行 git init（主分支 ${main}）`;
  }
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(top) !== realpathSync(root)) throw new Error(`请在仓库根目录 ${top} 执行 /forge-init`);
  const created: string[] = [];
  const existing: string[] = [];
  const differs: string[] = [];

  for (const [rel, content] of skeleton(packageRoot, path.basename(root))) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) {
      existing.push(rel);
      if (!USER_OWNED.has(rel) && !rel.startsWith(EXAMPLES_DIR) && readFileSync(abs, 'utf8') !== content) differs.push(rel);
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    created.push(rel);
  }
  const gi = path.join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const block = readFileSync(path.join(packageRoot, 'templates/gitignore.append'), 'utf8').replace(/^\n+/, '');
  const norm = (l: string) => l.trim().replace(/^\//, '').replace(/\/$/, '');
  const have = new Set(giText.split(/\r?\n/).map(norm));
  const rules = block.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const missing = rules.filter((l) => !have.has(norm(l)));
  if (missing.length) {
    // 一条都没有时追加整段（带注释），否则只补缺的行
    const add = missing.length === rules.length ? `${giText ? '\n' : ''}${block}` : `${missing.join('\n')}\n`;
    appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}${add}`);
    created.push(`.gitignore（追加 ${missing.join('、')}）`);
  }

  let commit: string | null = null;
  const paths = created.filter((c) => !c.startsWith(EXAMPLES_DIR)).map((c) => c.replace(/（.*$/, ''));
  if (paths.length) {
    git(root, ['add', '--', ...paths]);
    if (!gitOk(root, ['rev-parse', '--verify', 'HEAD']) || !gitOk(root, ['diff', '--cached', '--quiet', '--', ...paths])) {
      git(root, ['commit', '-q', '--no-verify', '-m', 'pi-forge: 初始化项目骨架', '--', ...paths], { engineIdentity: true });
      commit = git(root, ['rev-parse', 'HEAD']).trim();
    }
  }
  if (!existsSync(path.join(root, '.forge', 'state.json'))) {
    if (!gitOk(root, ['rev-parse', '--verify', 'HEAD'])) {
      git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'pi-forge: 初始提交'], { engineIdentity: true });
    }
    await StateStore.init(root);
    created.push('.forge/');
  } else {
    existing.push('.forge/');
  }
  const index = buildIndex && !codegraphIndexed(root) ? await buildIndex(root) : null;
  return { git: gitLine, created, existing, differs, commit, preflight: preflight({ root, ...deps }), index };
}

/** 主分支名：项目已有 workflow.yaml 时取它的 main_branch，否则取模板的（只读这一个键，配置有别的错误也不影响 init） */
function mainBranchFor(root: string, packageRoot: string): string {
  const file = [path.join(root, 'workflow.yaml'), path.join(packageRoot, 'templates/workflow.yaml')].find((f) => existsSync(f));
  return (file && /^main_branch:\s*["']?([^"'\s#]+)/m.exec(readFileSync(file, 'utf8'))?.[1]) || 'main';
}

export function formatInit(r: InitReport): string {
  return [
    `git：${r.git}`,
    r.created.length ? `新建：\n${r.created.map((c) => `  + ${c}`).join('\n')}` : '没有需要新建的文件。',
    r.existing.length ? `已存在（未覆盖）：${r.existing.length} 项` : '',
    r.differs.length ? `与模板不同（保留你的版本）：\n${r.differs.map((c) => `  ~ ${c}`).join('\n')}` : '',
    r.commit ? `已提交：${r.commit.slice(0, 8)} pi-forge: 初始化项目骨架` : '',
    r.created.some((c) => c.startsWith(EXAMPLES_DIR)) ? `示例 PRD、技术栈与原型在 ${EXAMPLES_DIR}（只供参考，不提交）` : '',
    r.index ?? '',
  ].filter(Boolean).join('\n');
}
