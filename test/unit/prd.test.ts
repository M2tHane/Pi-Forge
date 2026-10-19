// docs/PRD.md 的解析与检查（纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { acMap, acTexts, checkPrd, conventionsSection, pageOf, parsePrd, prototypePath } from '../../src/core/spec/prd.ts';

const PRD = [
  '# 库存管理 PRD',
  '',
  '## 6. 需求',
  '',
  '### 6.1 登录  REQ-001',
  '用户用账号密码登录。',
  '',
  '- AC1 Given 已注册 When 输入正确的密码 Then 进入首页',
  '- AC2：Given 密码错误 When 登录 Then 提示"账号或密码错误"',
  '  补充说明不算 AC',
  '',
  '### 6.3 商品  REQ-003',
  '- AC1 Given 有商品 When 打开列表 Then 按名称排序',
  '```',
  '- AC9 代码块里的不算',
  '```',
  '#### 字段',
  '- AC2 Given 名称为空 When 保存 Then 提示必填',
  '',
  '## 7. 页面',
  '',
  '| 页面 | 原型文件 | 对应需求 |',
  '|---|---|---|',
  '| login | docs/prototype/login.html | REQ-001 |',
  '| 商品列表 | `products.html` | REQ-003、REQ-004 |',
  '',
  '- AC3 页面表之后、下一个需求之前的 AC 不属于任何需求',
  '',
  '## 8. 通用约定',
  '- 名称最长 50 个字符',
  '- 金额保留两位小数',
  '',
  '## 9. 不做的',
  '- 导出',
].join('\n');

test('parsePrd：标题里的 REQ 编号、需求下以 - ACn 开头的行、页面表', () => {
  const prd = parsePrd(PRD);
  assert.deepEqual(prd.reqs.map((r) => [r.id, r.title, r.acs.map((a) => a.id)]), [
    ['REQ-001', '6.1 登录', ['AC1', 'AC2']],
    ['REQ-003', '6.3 商品', ['AC1', 'AC2']],
  ]);
  assert.equal(prd.reqs[0]!.acs[1]!.text, 'Given 密码错误 When 登录 Then 提示"账号或密码错误"');
  assert.equal(prd.reqs[0]!.line, 5);
  assert.deepEqual(prd.pages.map((p) => [p.name, p.file, p.reqs]), [
    ['login', 'docs/prototype/login.html', ['REQ-001']],
    ['商品列表', 'docs/prototype/products.html', ['REQ-003', 'REQ-004']],
  ]);
  assert.equal(acMap(prd).get('REQ-003.AC2'), 'Given 名称为空 When 保存 Then 提示必填');
  assert.deepEqual(acTexts(prd, ['REQ-001.AC1', 'REQ-404.AC1']), { 'REQ-001.AC1': 'Given 已注册 When 输入正确的密码 Then 进入首页' });
});

test('checkPrd：没有 REQ、REQ 没有 AC、编号重复、原型文件缺失或没写时只给警告', () => {
  assert.match(checkPrd(parsePrd('# 只有标题\n正文'), () => true).join('\n'), /没有解析出任何需求/);
  const md = [
    '### 登录 REQ-001', '- AC1 a', '- AC1 b',
    '### 登录 REQ-001', '- AC1 c',
    '### 注册 REQ-002', '说明但没有 AC',
    '| 页面 | 原型文件 |', '| --- | --- |', '| 登录 | login.html |', '| 注册 | |',
  ].join('\n');
  const warnings = checkPrd(parsePrd(md), (rel) => rel !== 'docs/prototype/login.html');
  assert.deepEqual(warnings, [
    'REQ-001 出现了多次（第 1、4 行），已合并成一条',
    'REQ-001.AC1 出现了两次（第 3 行）',
    'REQ-001.AC1 出现了两次（第 5 行）',
    'REQ-002「注册」没有验收标准：在需求下面每条一行，以「- AC1」开头',
    '页面「登录」的原型文件 docs/prototype/login.html 不存在',
    '页面表第 11 行「注册」没有写原型文件',
  ]);
  // 示例里页面表之后、下一个需求之前的那条 AC 不属于任何需求
  assert.deepEqual(checkPrd(parsePrd(PRD), () => true), ['第 27 行的验收标准不在任何需求下面，没有计入：放到对应需求的标题（带 REQ 编号）下面']);
});

test('prototypePath、pageOf、conventionsSection', () => {
  assert.equal(prototypePath('[商品](docs/prototype/p/list.html)'), 'docs/prototype/p/list.html');
  assert.equal(prototypePath('./a.html'), 'docs/prototype/a.html');
  assert.equal(prototypePath(' '), '');
  const prd = parsePrd(PRD);
  assert.equal(pageOf(prd, 'login')?.file, 'docs/prototype/login.html');
  assert.equal(pageOf(prd, 'products')?.name, '商品列表');
  assert.equal(pageOf(prd, 'nope'), undefined);
  assert.equal(conventionsSection(PRD), '- 名称最长 50 个字符\n- 金额保留两位小数');
  assert.equal(conventionsSection('# 无'), '');
});

test('templates/examples 的示例 PRD 照约定写成：解析无警告，页面表的原型都在示例里', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const md = readFileSync(path.join(root, 'templates/examples/PRD.md'), 'utf8');
  const prd = parsePrd(md);
  assert.ok(prd.reqs.length >= 3);
  assert.ok(prd.reqs.every((r) => r.acs.length >= 2));
  assert.ok(prd.pages.length >= 2);
  // 照抄到 docs/ 后原型在 docs/prototype/ 下；示例里对应 templates/examples/prototype/
  const exists = (rel: string) => rel.startsWith('docs/prototype/') && existsSync(path.join(root, 'templates/examples/prototype', rel.slice('docs/prototype/'.length)));
  assert.deepEqual(checkPrd(prd, exists), []);
  assert.ok(conventionsSection(md).length > 0);
});

test('分组标题与重复编号：标题里有多个编号的不是需求；单个编号在标题开头或末尾都认；重复的合并成有 AC 的那条', () => {
  const md = [
    '## 功能需求（REQ-001 ~ REQ-002）',
    '### REQ-001 登录',
    '- AC1 a',
    '### 商品 REQ-002',
    '- AC1 b',
    '## 范围 REQ-003',
    '### 6.3 报表 REQ-003',
    '- AC1 c',
  ].join('\n');
  const prd = parsePrd(md);
  assert.deepEqual(prd.reqs.map((r) => [r.id, r.title, r.line, r.acs.map((a) => a.text)]), [
    ['REQ-001', '登录', 2, ['a']],
    ['REQ-002', '商品', 4, ['b']],
    ['REQ-003', '6.3 报表', 7, ['c']],
  ]);
  assert.equal(prd.reqs.find((r) => r.id === 'REQ-003')!.acs.length, 1, '按编号 find 取到的是有 AC 的那条');
  assert.ok(checkPrd(prd, () => true).includes('REQ-003 出现了多次（第 6、7 行），已合并成一条'));
});

test('AC 的常见写法：有序列表、勾选框、加粗都识别；像 AC 但没识别的行给警告', () => {
  const md = [
    '### 登录 REQ-001',
    '- **AC1** 加粗',
    '1. AC2 有序列表',
    '- [ ] AC3 勾选框',
    '- **AC4：** 冒号在加粗里',
    '2) **AC5**：冒号在加粗外',
    '* AC6. 句点',
    'AC7 没有列表符号',
    '| AC8 | 表格 |',
    '- AC 9 中间有空格',
    '- ACCOUNT 不是 AC',
  ].join('\n');
  const prd = parsePrd(md);
  assert.deepEqual(prd.reqs[0]!.acs.map((a) => [a.id, a.text]), [
    ['AC1', '加粗'], ['AC2', '有序列表'], ['AC3', '勾选框'], ['AC4', '冒号在加粗里'], ['AC5', '冒号在加粗外'], ['AC6', '句点'],
  ]);
  assert.deepEqual(checkPrd(prd, () => true).filter((w) => /写法没有识别/.test(w)), [
    '第 8 行像是 REQ-001 的验收标准，但写法没有识别：「AC7 没有列表符号」。每条一行，以「- AC1」开头',
    '第 9 行像是 REQ-001 的验收标准，但写法没有识别：「| AC8 | 表格 |」。每条一行，以「- AC1」开头',
    '第 10 行像是 REQ-001 的验收标准，但写法没有识别：「- AC 9 中间有空格」。每条一行，以「- AC1」开头',
  ]);
});

test('不在任何需求下面的 AC 行：不计入任何需求，警告里列出行号', () => {
  const md = [
    '# PRD',
    '- AC1 写在需求标题之前',
    '## 3. 需求',
    '### 登录 REQ-001',
    '- AC1 正常',
    '## 4. 页面',
    '- AC2 写到了别的章节下面',
  ].join('\n');
  const prd = parsePrd(md);
  assert.deepEqual(prd.reqs[0]!.acs.map((a) => a.id), ['AC1']);
  assert.deepEqual(checkPrd(prd, () => true).filter((w) => /不在任何需求下面/.test(w)), ['第 2、7 行的验收标准不在任何需求下面，没有计入：放到对应需求的标题（带 REQ 编号）下面']);
});

test('页面表的边界：|-|-| 分隔行、表头写「页面名称」、表格后紧跟含「 | 」的段落、没有页面表', () => {
  const md = [
    '### 登录 REQ-001', '- AC1 a', '',
    '| 页面名称 | 原型 | 对应需求 |', '|-|-|-|', '| login | login.html | REQ-001 |',
    '说明：a | b 不是表格行',
    '',
    '页面 | 原型文件', '--- | ---', 'list | list.html',
  ].join('\n');
  const prd = parsePrd(md);
  assert.deepEqual(prd.pages.map((p) => [p.name, p.file, p.reqs]), [
    ['login', 'docs/prototype/login.html', ['REQ-001']],
    ['list', 'docs/prototype/list.html', []],
  ]);
  assert.deepEqual(checkPrd(prd, () => true), []);
  assert.deepEqual(checkPrd(parsePrd('### 登录 REQ-001\n- AC1 a\n\n| 名字 | 原型 |\n|---|---|\n| a | a.html |'), () => true),
    ['docs/PRD.md 里没有找到页面表：表头要有「页面」与「原型文件」两列，例如「| 页面 | 原型文件 | 对应需求 |」']);
});

test('prototypePath：URL 编码、尖括号、锚点、相对 docs/ 的 prototype/ 路径', () => {
  assert.equal(prototypePath('[商品](docs/prototype/%E5%95%86%E5%93%81.html)'), 'docs/prototype/商品.html');
  assert.equal(prototypePath('[a](<docs/prototype/a b.html>)'), 'docs/prototype/a b.html');
  assert.equal(prototypePath('<a.html>'), 'docs/prototype/a.html');
  assert.equal(prototypePath('[a](prototype/a.html#list "标题")'), 'docs/prototype/a.html');
  assert.equal(prototypePath('`prototype/sub/b.html`'), 'docs/prototype/sub/b.html');
  assert.equal(prototypePath('/docs/prototype/c.html'), 'docs/prototype/c.html');
  assert.equal(prototypePath('100%.html'), 'docs/prototype/100%.html');
});

test('代码块围栏：结束围栏与开头同字符且不短于开头，四个反引号的块不在内层三个反引号处结束', () => {
  const md = [
    '### 登录 REQ-001',
    '````md', '```', '- AC8 内层代码块之后仍在外层块里', '```', '- AC9 也在外层块里', '````',
    '~~~', '```', '- AC7 波浪线块里的反引号不结束它', '~~~',
    '- AC1 块外的才算',
  ].join('\n');
  assert.deepEqual(parsePrd(md).reqs[0]!.acs.map((a) => a.id), ['AC1']);
});
