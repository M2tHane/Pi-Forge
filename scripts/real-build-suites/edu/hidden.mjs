// 培训学校教务系统的隐藏测试（PRD.md 的验收）：在交付的项目上起数据库容器、./setup.sh、./run.sh，按需求逐条调用 HTTP 接口。
// 用法：node hidden.mjs <项目目录>
// 输出格式给 scripts/real-build/common.ts 的 parseHidden：每组 "## 组名（通过/总数）"，每条 "✓ 标题" 或 "✗ 标题：原因"，最后 "合计：x/y"。
// 用例在 hidden/p1.mjs … p5b.mjs，按期执行、共用一个数据库；组名带期数，便于按期统计。
// 环境变量 HIDDEN_ONLY=p1,p3 只跑这几期（调试用）；HIDDEN_KEEP=1 跑完不删数据库容器。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, check, get, group, groups, login, req, rt } from './hidden/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(process.argv[2] ?? '.');
const composeName = `eduhidden${process.pid}`;
let dbPort = 0;
let port = 0;
let server = null;
let serverLog = '';

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 400) => String(s).slice(-n).replace(/\s+/g, ' ');

function sh(cmd, args, { env = {}, timeoutMs = 10 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}
const dbEnv = () => ({ DB_PORT: String(dbPort), COMPOSE_PROJECT_NAME: composeName });
const databaseUrl = () => `postgresql://edu:edu@localhost:${dbPort}/edu`;

async function start() {
  serverLog = '';
  server = spawn('./run.sh', [], { cwd: project, env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl() }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(`${rt.base}/api/health`); if (r.status === 200) return; } catch { /* 还没起来 */ }
    if (server.exitCode !== null) throw new Error(`./run.sh 退出（${server.exitCode}）：${tail(serverLog)}`);
    await sleep(200);
  }
  throw new Error(`60 秒内 /api/health 没有返回 200：${tail(serverLog)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  await Promise.race([exited, sleep(8000)]);
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

const PHASES = ['p1', 'p2', 'p3', 'p4', 'p5a', 'p5b'];
const only = process.env.HIDDEN_ONLY?.split(',').filter(Boolean);

async function run() {
  group('启动');
  let ready = true;
  await check('仓库根目录有 docker-compose.yml、setup.sh、run.sh', async () => {
    for (const f of ['docker-compose.yml', 'setup.sh', 'run.sh']) assert.ok(existsSync(path.join(project, f)), `没有 ${f}`);
  });
  await check('docker compose up -d --wait db 能起到健康状态（-p 与 DB_PORT 隔离）', async () => {
    const r = sh('docker', ['compose', '-p', composeName, 'up', '-d', '--wait', 'db'], { env: dbEnv(), timeoutMs: 5 * 60_000 });
    if (r.code !== 0) { ready = false; throw new Error(`退出码 ${r.code}：${tail(r.out)}`); }
  });
  await check('./setup.sh 成功，且能重复执行', async () => {
    const a = sh('./setup.sh', [], { env: { DATABASE_URL: databaseUrl() } });
    if (a.code !== 0) { ready = false; throw new Error(`第一次退出码 ${a.code}：${tail(a.out)}`); }
    const b = sh('./setup.sh', [], { env: { DATABASE_URL: databaseUrl() } });
    assert.equal(b.code, 0, `第二次退出码 ${b.code}：${tail(b.out)}`);
  });
  if (!ready) return;
  await check('./run.sh 在空数据库上启动，GET /api/health 不用登录返回 {ok:true}', async () => {
    await start();
    const r = await req('GET', '/api/health', undefined, { as: null });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  });
  if (!server || server.exitCode !== null) return;
  await check('第一次启动自动创建 admin/admin123（姓名 管理员）', async () => {
    rt.adminToken = await login('admin', 'admin123');
    const me = await get('/api/auth/me');
    assert.equal(me.username, 'admin'); assert.equal(me.name, '管理员'); assert.equal(me.role, 'admin');
  });
  if (!rt.adminToken) return;

  for (const p of PHASES) {
    if (only && !only.includes(p)) continue;
    const file = path.join(here, 'hidden', `${p}.mjs`);
    // 中途抛错时没跑到的用例按失败计，总数不随实现的好坏变化（按文件里 check( 的个数估计，循环里的只算一次）
    const planned = (readFileSync(file, 'utf8').match(/\bawait check\(/g) ?? []).length;
    const before = groups.reduce((n, g) => n + g.cases.length, 0);
    try { await (await import(file)).run(); }
    catch (e) {
      const ran = groups.reduce((n, g) => n + g.cases.length, 0) - before;
      group(`${{ p1: '一期', p2: '二期', p3: '三期', p4: '四期' }[p] ?? '五期'}·中途出错（${p}）`);
      const why = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
      for (let i = 0; i < Math.max(1, planned - ran); i++) await check(`第 ${ran + i + 1} 条起没有执行（用例代码抛出：${why}）`, async () => { throw e; });
    }
  }

  group('页面与持久化');
  const pages = ['/login', '/', '/account/password', '/users', '/campuses', '/rooms', '/subjects', '/courses', '/calendar', '/teachers', '/teachers/1',
    '/leads', '/leads/1', '/trials', '/students', '/students/1', '/discounts', '/orders/new', '/orders', '/orders/1', '/orders/1/receipt',
    '/classes', '/classes/new', '/classes/1', '/classes/1/edit', '/schedule', '/lessons/1', '/lessons/1/attendance', '/leaves', '/makeups', '/my/schedule',
    '/refunds', '/refunds/1', '/course-transfers', '/payments', '/reports/revenue', '/pay-rates', '/payrolls', '/payrolls/1', '/my/pay',
    '/homeworks', '/homeworks/1', '/exams', '/exams/1', '/lessons/1/feedback', '/notifications', '/announcements',
    '/reports/enrollment', '/reports/consumption', '/reports/low-balance', '/audit-logs',
    '/parent', '/parent/schedule', '/parent/homeworks', '/parent/reports', '/parent/notifications'];
  await check(`${pages.length} 个页面路径直接打开（不带令牌）都返回 HTML`, async () => {
    const bad = [];
    for (const p of pages) {
      const r = await req('GET', p, undefined, { as: null });
      if (r.status !== 200 || !/text\/html/.test(r.type)) bad.push(`${p}→${r.status}`);
    }
    assert.deepEqual(bad, []);
  });
  await check('/api/ 下不存在的路径返回 404 not_found（JSON），不是页面', async () => {
    const r = await req('GET', '/api/no-such-thing');
    assert.equal(r.status, 404); assert.match(r.type, /application\/json/); assert.equal(r.json?.error?.code, 'not_found');
  });
  await check('重启后数据、令牌与单号计数都保留', async () => {
    const before = await get('/api/students?page_size=1');
    await stop(); await start();
    const after = await get('/api/students?page_size=1');
    assert.equal(after.total, before.total);
    const campus = (await get('/api/campuses?page_size=100')).items.find((c) => c.active);
    const s = await req('POST', '/api/students', { name: '重启后新建', campus_id: campus.id });
    assert.equal(s.status, 201, s.text.slice(0, 200));
    const lastNo = before.items[0]?.no ?? 'S000000';
    assert.equal(s.json.no, `S${String(Number(lastNo.slice(1)) + 1).padStart(6, '0')}`, `重启前最大学号 ${lastNo}`);
  });
}

let crashed = null;
try {
  dbPort = await freePort();
  port = await freePort();
  rt.base = `http://127.0.0.1:${port}`;
  await run();
} catch (e) { crashed = String(e?.stack ?? e); }
finally {
  await stop();
  if (!process.env.HIDDEN_KEEP) sh('docker', ['compose', '-p', composeName, 'down', '-v', '--remove-orphans'], { env: dbEnv(), timeoutMs: 2 * 60_000 });
}

let pass = 0;
let total = 0;
for (const g of groups) {
  const okN = g.cases.filter((c) => c.ok).length;
  pass += okN; total += g.cases.length;
  console.log(`## ${g.name}（${okN}/${g.cases.length}）`);
  for (const c of g.cases) console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}：${c.why}`);
}
if (crashed) console.log(`（中途出错：${tail(crashed, 600)}）`);
console.log(`合计：${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
