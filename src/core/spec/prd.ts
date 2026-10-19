// docs/PRD.md 的轻量解析与检查：需求编号 REQ-xxx、验收标准 - ACn、页面表。PRD 由用户在流程外写好，是需求的唯一依据，
// 程序只读出编号与对照关系（覆盖率、审查材料、阶段验收要用），检查结果只警告、不拦流程。解析与检查是纯函数。
import path from 'node:path';
import { git, gitOk } from '../state/git.ts';

export const PRD_PATH = 'docs/PRD.md';
export const PROTOTYPE_DIR = 'docs/prototype';
/** 用户随原型提供的设计说明与主题样式：前端基础以它们为准建公共组件（拷到产品里再补充，原件不改） */
export const DESIGN_FILES = [`${PROTOTYPE_DIR}/DESIGN.md`, `${PROTOTYPE_DIR}/theme.css`] as const;
/** 用户定的技术栈：和 PRD 一样由用户在流程外写好，程序只检查它存在，不解析内容 */
export const ARCHITECTURE_PATH = 'docs/ARCHITECTURE.md';

export interface PrdAc { id: string; text: string; line: number }
/** dupLines：同一个编号的需求标题又出现的行（解析时已合并到这一条，checkPrd 据此警告） */
export interface PrdReq { id: string; title: string; line: number; acs: PrdAc[]; dupLines?: number[] }
/** 页面表的一行：页面名、原型文件（相对仓库根）、对应需求 */
export interface PrdPage { name: string; file: string; reqs: string[]; line: number }
/** looseAcs：需求下面像是 AC、但写法没有识别的行；orphanAcs：不在任何需求下面的 AC 行的行号（都由 checkPrd 警告） */
export interface Prd { reqs: PrdReq[]; pages: PrdPage[]; looseAcs?: { req: string; line: number; text: string }[]; orphanAcs?: number[] }

const REQ_IDS = /REQ-\d{3,}/g;
// 列表项（- * + 或 1. 1)），可带勾选框 [ ] 与加粗：「- AC1 …」「1. AC4 …」「- [ ] AC2 …」「- **AC2** …」「- **AC2：** …」
const AC_LINE = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(\*\*|__)?(AC\d+)(?![\w])\s*[:：.、]?\s*\1\s*[:：.、]?\s*(.*)$/i;
// 去掉列表符号、引用、表格竖线、勾选框、加粗后以 ACn 开头：用来提醒没有识别的写法
const LOOSE_AC = /^(?:[-*+>|]|\d+[.)]|\[[ xX]\]|\*\*|__|\s)*AC[\s-]*\d+(?!\w)/i;
const splitLines = (md: string): string[] => md.replace(/\r\n?/g, '\n').split('\n');

function cells(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('|') && !t.includes(' | ')) return null;
  const parts = t.split(/(?<!\\)\|/);
  if (!parts[0]?.trim()) parts.shift();
  if (!parts.at(-1)?.trim()) parts.pop();
  return parts.map((p) => p.trim().replace(/\\\|/g, '|'));
}
const isSeparator = (row: readonly string[]) => row.every((c) => /^:?-+:?$/.test(c));
const PAGE_HEADER = /^(?:页面|页面名|页面名称|页面\s*id|page|page\s*id)$/i;

/**
 * 原型文件格里的路径：去掉反引号、Markdown 链接、尖括号与 #锚点，解开 URL 编码；
 * 只写文件名时放在 docs/prototype/ 下，写成 prototype/…（相对 docs/）时补上 docs/
 */
export function prototypePath(cell: string): string {
  const link = /\]\(\s*(<[^>]*>|[^)\s]+)/.exec(cell);
  let raw = (link ? link[1]! : cell).replace(/`/g, '').trim().replace(/^<(.*)>$/, '$1').replace(/#.*$/, '').trim();
  try { raw = decodeURIComponent(raw); } catch { /* 不是合法的 URL 编码：按原样用 */ }
  raw = raw.replace(/^(?:\.\/|\/)+/, '');
  if (!raw) return '';
  if (raw.startsWith('prototype/')) return `docs/${raw}`;
  return raw.includes('/') ? raw : `${PROTOTYPE_DIR}/${raw}`;
}

export interface Fence { char: string; len: number; info: string }
/** 开头围栏（CommonMark）：至少三个 ` 或 ~，info 是后面的语言标记 */
export function fenceOpen(line: string): Fence | null {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
  if (!m || (m[1]![0] === '`' && m[2]!.includes('`'))) return null;
  return { char: m[1]![0]!, len: m[1]!.length, info: m[2]!.trim() };
}
/** 结束围栏：与开头同一种字符、长度不少于开头、后面没有别的内容（四个反引号的块不会在内层三个反引号处结束） */
export function closesFence(line: string, open: Fence): boolean {
  const m = /^(`{3,}|~{3,})$/.exec(line.trim());
  return !!m && m[1]![0] === open.char && m[1]!.length >= open.len;
}

export function parsePrd(md: string): Prd {
  const reqs: PrdReq[] = [];
  const pages: PrdPage[] = [];
  const looseAcs: NonNullable<Prd['looseAcs']> = [];
  const orphanAcs: number[] = [];
  let current: { req: PrdReq; level: number } | null = null;
  // piped：表头以 | 开头时，表格行也要以 | 开头，表格后面紧跟的含「 | 」的段落不算表格行
  let table: { page: number; file: number; reqs: number; piped: boolean } | null = null;
  let fence: Fence | null = null;
  splitLines(md).forEach((raw, i) => {
    const line = i + 1;
    const text = raw.trim();
    if (fence) { if (closesFence(text, fence)) fence = null; return; }
    fence = fenceOpen(text);
    if (fence) return;
    const row = cells(text);
    if (!row || (table?.piped && !text.startsWith('|'))) table = null;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      // 标题里有多个编号（如「功能需求（REQ-001 ~ REQ-009）」）是分组标题，不是一条需求
      const ids = heading[2]!.match(REQ_IDS) ?? [];
      const id = ids.length === 1 ? ids[0] : undefined;
      if (id) {
        const title = heading[2]!.replace(id, '').replace(/\s+/g, ' ').replace(/^[\s:：\-—|]+|[\s:：\-—|]+$/g, '').trim();
        const req: PrdReq = { id, title, line, acs: [] };
        reqs.push(req);
        current = { req, level };
      } else if (current && level <= current.level) current = null;
      return;
    }
    if (row) {
      if (table) {
        if (isSeparator(row)) return;
        const name = row[table.page] ?? '';
        const file = prototypePath(row[table.file] ?? '');
        const reqCell = table.reqs >= 0 ? row[table.reqs] ?? '' : row.join(' ');
        if (name || file) pages.push({ name, file, reqs: reqCell.match(REQ_IDS) ?? [], line });
        return;
      }
      const page = row.findIndex((c) => PAGE_HEADER.test(c));
      const file = row.findIndex((c) => /原型|prototype/i.test(c));
      if (page >= 0 && file >= 0) { table = { page, file, reqs: row.findIndex((c) => c.includes('需求')), piped: text.startsWith('|') }; return; }
    }
    const ac = AC_LINE.exec(text);
    if (ac && current) current.req.acs.push({ id: ac[2]!.toUpperCase(), text: ac[3]!.trim(), line });
    else if (ac) orphanAcs.push(line);
    else if (current && LOOSE_AC.test(text)) looseAcs.push({ req: current.req.id, line, text });
  });
  return { reqs: mergeDuplicates(reqs), pages, ...(looseAcs.length ? { looseAcs } : {}), ...(orphanAcs.length ? { orphanAcs } : {}) };
}

/** 同一个编号出现多次时合并成一条：标题与行号取第一条有 AC 的，AC 按出现顺序合在一起；调用方按编号 find 时不会取到空的那条 */
function mergeDuplicates(reqs: PrdReq[]): PrdReq[] {
  const groups = new Map<string, PrdReq[]>();
  for (const r of reqs) groups.set(r.id, [...(groups.get(r.id) ?? []), r]);
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0]!;
    const main = g.find((r) => r.acs.length) ?? g[0]!;
    return { ...main, acs: g.flatMap((r) => r.acs), dupLines: g.filter((r) => r !== main).map((r) => r.line) };
  });
}

/**
 * 检查（只警告）：解析不出任何 REQ、某条 REQ 没有 AC、AC 不在任何 REQ 下面、页面表引用的原型文件不存在、同一个编号出现多次。
 * exists 判断仓库里的文件是否存在（路径相对仓库根）。
 */
export function checkPrd(prd: Prd, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  if (!prd.reqs.length) out.push(`${PRD_PATH} 里没有解析出任何需求：需求标题里要带编号，例如「### 6.3 商品  REQ-003」`);
  for (const r of prd.reqs) {
    if (r.dupLines?.length) out.push(`${r.id} 出现了多次（第 ${[r.line, ...r.dupLines].sort((a, b) => a - b).join('、')} 行），已合并成一条`);
    if (!r.acs.length) out.push(`${r.id}「${r.title}」没有验收标准：在需求下面每条一行，以「- AC1」开头`);
    const acs = new Set<string>();
    for (const a of r.acs) {
      if (acs.has(a.id)) out.push(`${r.id}.${a.id} 出现了两次（第 ${a.line} 行）`);
      acs.add(a.id);
    }
  }
  if (prd.orphanAcs?.length) out.push(`第 ${prd.orphanAcs.join('、')} 行的验收标准不在任何需求下面，没有计入：放到对应需求的标题（带 REQ 编号）下面`);
  for (const l of prd.looseAcs ?? []) out.push(`第 ${l.line} 行像是 ${l.req} 的验收标准，但写法没有识别：「${l.text.length > 40 ? `${l.text.slice(0, 40)}…` : l.text}」。每条一行，以「- AC1」开头`);
  if (!prd.pages.length) out.push(`${PRD_PATH} 里没有找到页面表：表头要有「页面」与「原型文件」两列，例如「| 页面 | 原型文件 | 对应需求 |」`);
  for (const p of prd.pages) {
    if (!p.file) out.push(`页面表第 ${p.line} 行「${p.name}」没有写原型文件`);
    else if (!exists(p.file)) out.push(`页面「${p.name}」的原型文件 ${p.file} 不存在`);
  }
  return out;
}

/** 全部 AC：`REQ-003.AC1` → 原文 */
export function acMap(prd: Prd): Map<string, string> {
  return new Map(prd.reqs.flatMap((r) => r.acs.map((a) => [`${r.id}.${a.id}`, a.text] as const)));
}

/** 给出的 AC 编号中能在 PRD 里找到的原文；找不到的不返回 */
export function acTexts(prd: Prd, ids: readonly string[]): Record<string, string> {
  const all = acMap(prd);
  return Object.fromEntries(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
}

/** 计划里的页面 id 对应的页面表行：页面名相同，或原型文件名（不含扩展名）相同 */
export function pageOf(prd: Prd, id: string): PrdPage | undefined {
  return prd.pages.find((p) => p.name === id) ?? prd.pages.find((p) => p.file && path.posix.basename(p.file).replace(/\.[^.]+$/, '') === id);
}

/** 「通用约定」一节（不含标题，到下一个二级标题为止）；没有这一节时为空 */
export function conventionsSection(md: string): string {
  const lines = splitLines(md);
  const start = lines.findIndex((l) => /^##\s*(?:[\d.、]+\s*)?通用约定\s*$/.test(l.trim()));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** 读某个提交或分支上的 PRD 原文；没有时为 null */
export function readPrdText(root: string, ref: string): string | null {
  const obj = `${ref}:${PRD_PATH}`;
  return gitOk(root, ['cat-file', '-e', obj]) ? git(root, ['show', obj]) : null;
}

/** 某个提交或分支上的 PRD；没有时为空（没有需求、没有页面） */
export function readPrd(root: string, ref: string): Prd {
  const text = readPrdText(root, ref);
  return text === null ? { reqs: [], pages: [] } : parsePrd(text);
}

/** 某个提交或分支上的 PRD 检查（只警告）：原型文件在同一个提交里找 */
export function prdWarningsAt(root: string, ref: string): string[] {
  const text = readPrdText(root, ref);
  if (text === null) return [`${ref} 上没有 ${PRD_PATH}`];
  return checkPrd(parsePrd(text), (rel) => gitOk(root, ['cat-file', '-e', `${ref}:${rel}`]));
}
