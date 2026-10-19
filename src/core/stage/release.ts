// 把集成分支合入主分支：S0（架构）审查通过后的门禁一次（每次返工后再一次），流程最后一个闸门经用户确认后一次。
// 中止的流程不再合入，集成分支保留；S0 已经合入主分支的骨架不撤回。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../state/config.ts';
import type { StateStore } from '../state/state-store.ts';
import { dirtyFiles, git, gitOk } from '../state/git.ts';
import { worktreesRoot, removeWorktree } from '../workspace/worktree.ts';
import { ARCHITECTURE_PATH, PRD_PATH, PROTOTYPE_DIR } from '../spec/prd.ts';
import { isArchitectStage } from '../plan/plan-flow.ts';

export async function mergeToMain(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string> {
  const flow = store.readFlow(flowId);
  const main = config.raw.main_branch;
  const integ = flow.integration_branch;
  const msg = `pi-forge: 合入 ${flow.id} ${flow.title}`.slice(0, 200);
  if (gitOk(root, ['merge-base', '--is-ancestor', integ, main])) throw new Error(`${integ} 已经包含在 ${main} 中，无需合入`);
  const current = gitOk(root, ['symbolic-ref', '-q', 'HEAD']) ? git(root, ['symbolic-ref', '--short', 'HEAD']).trim() : null;
  // S0 由门禁合入（出错时自动重试），最后一个阶段由用户批准时合入
  const s0 = isArchitectStage(flow.stage);
  const after = s0 ? '程序会自动重试（或用 /forge gate 立即重跑）' : '再 /forge-approve';

  let dir = root;
  let temp: string | null = null;
  if (current === main) {
    const dirty = [...dirtyFiles(root)];
    const inputs = dirty.filter((f) => f === PRD_PATH || f === ARCHITECTURE_PATH || f.startsWith(`${PROTOTYPE_DIR}/`));
    if (inputs.length) {
      throw new Error([`主工作区里的需求输入在流程开始后改过（没有提交）：${inputs.slice(0, 10).join('、')}${inputs.length > 10 ? ` 等 ${inputs.length} 个` : ''}。`,
        `流程用的是开始时提交到 ${main} 的版本，这些改动没有进流程，所以先不合入。可以：`,
        `- 不需要这些改动：撤销它们（git restore 或删掉新加的文件）后${after}；`,
        `- 按新版本返工：先把改动提交到 ${main}，/forge sync 同步进集成分支，${s0 ? '合入完成、等你验收时' : ''}再 /forge-reject "<意见>"；`,
        // S0 合入后集成分支移到合入后的提交，之后各批读到的就是新版本
        `- 改动留给以后：先提交到 ${main}，之后${after}（${s0 ? '架构不按它返工，但批准后各批读的是新版本' : '这次交付不按它修改'}）。`].join('\n'));
    }
    if (dirty.length) throw new Error(`主工作区有未提交的改动，无法合入 ${main}：${dirty.slice(0, 10).join('、')}。请先提交或暂存，之后${after}。`);
  } else {
    temp = path.join(worktreesRoot(root), `${flowId}-release`);
    mkdirSync(path.dirname(temp), { recursive: true });
    removeWorktree(root, temp);
    try {
      git(root, ['worktree', 'add', '-q', temp, main]);
    } catch (e) {
      throw new Error(`无法检出 ${main} 进行合入（可能已在其他 worktree 中检出）：${(e as Error).message}`);
    }
    dir = temp;
  }
  try {
    try {
      git(dir, ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', msg, integ], { engineIdentity: true, allowFail: true });
    } catch (e) {
      const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      gitOk(dir, ['merge', '--abort']);
      // 没有冲突文件：失败来自别处（--no-verify 不跳过的 prepare-commit-msg 钩子、未跟踪文件会被覆盖等），原样给出 git 的输出
      if (!conflicts.length) throw new Error(`合入 ${main} 失败（没有冲突文件）：${(e as Error).message}\n处理后${after}。`);
      throw new Error(`合入 ${main} 时冲突：${conflicts.join('、')}。主分支在流程期间被修改过；请人工合并 ${integ}，之后${after}。`);
    }
    const sha = git(dir, ['rev-parse', 'HEAD']).trim();
    await store.recordEvent({ flow: flowId, actor: 'human', type: 'merge', evidence: sha, data: { from: integ, to: main } });
    return sha;
  } finally {
    if (temp) removeWorktree(root, temp);
  }
}

/**
 * S0 的门禁：架构产出（骨架、契约、计划、rules/、commands.yaml）合入主分支，再把集成分支移到合入后的提交，
 * 之后的阶段在它上面继续。用户在主工作区验收骨架；批准时再调用一次（已经合入时只移动集成分支）。
 */
export async function publishSkeleton(root: string, store: StateStore, config: FlowConfig, flowId: string): Promise<string> {
  const integ = store.readFlow(flowId).integration_branch;
  const main = config.raw.main_branch;
  const before = git(root, ['rev-parse', `refs/heads/${integ}`]).trim();
  // 上次已经合入、之后移动集成分支或记事件时失败：重试时集成分支已包含在主分支中，直接移过去
  const sha = gitOk(root, ['merge-base', '--is-ancestor', integ, main]) ? git(root, ['rev-parse', `refs/heads/${main}`]).trim() : await mergeToMain(root, store, config, flowId);
  git(root, ['update-ref', `refs/heads/${integ}`, sha, before]);
  return sha;
}
