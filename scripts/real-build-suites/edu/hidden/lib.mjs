// 隐藏测试共用的工具：HTTP 请求与断言、分组计分、北京时间的日期计算，以及造数据的 fx.*。
// 各期的用例（p1.mjs … p5.mjs）只 import 这里的东西；服务的起停在 ../hidden.mjs。
//
// 约定：
// - 每条用例 `await check('标题', async () => { ... })`，抛错就算失败；标题写清楚测的是哪条规则。
// - 用例按顺序执行、共用数据；前面造数据失败时，后面依赖它的用例跟着失败（这是预期的）。
// - 需要精确统计的报表（看板、收入确认、消课报表……）各自新建一个校区，用 campus_id 筛选，不受别的用例的数据影响。
// - 时间：PRD 按北京时间。"已经开始"的课次不能请假、调课、停课，所以要操作的课次放在 today+2 及以后；
//   要点名的课次放在今天及以前。日期用 day(n)（今天加 n 天的北京日期）。
import assert from 'node:assert/strict';

export { assert };

// —— 运行时状态（由 ../hidden.mjs 设置 base） ——
export const rt = { base: '', adminToken: null };

// —— 分组与计分 ——
export const groups = [];
let current = null;
export function group(name) { current = { name, cases: [] }; groups.push(current); }
export async function check(label, fn) {
  try { await fn(); current.cases.push({ label, ok: true }); }
  catch (e) { current.cases.push({ label, ok: false, why: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 240) }); }
}

// —— HTTP ——
/**
 * 发请求。as：令牌（默认 admin 的；null 表示不带）。raw：body 原样发送（测非法 JSON）。
 * 返回 { status, type, text, json, headers }。
 */
export async function req(method, url, body, { raw = false, as } = {}) {
  const headers = {};
  const t = as === undefined ? rt.adminToken : as;
  if (t) headers.authorization = `Bearer ${t}`;
  let payload;
  if (body !== undefined) { payload = raw ? body : JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(`${rt.base}${url}`, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  return { status: r.status, type: r.headers.get('content-type') ?? '', text, json, headers: r.headers };
}
const brief = (r) => `${r.status} ${r.text.slice(0, 200)}`;
/** 断言状态码（默认 200）并返回 JSON */
export function ok(r, status = 200) { assert.equal(r.status, status, `期望 ${status}，实际 ${brief(r)}`); return r.json; }
/** 断言错误响应：状态码与 error.code */
export function expectError(r, status, code) {
  assert.equal(r.status, status, `期望 ${status} ${code}，实际 ${brief(r)}`);
  assert.equal(r.json?.error?.code, code, `期望 error.code=${code}，实际 ${brief(r)}`);
  assert.equal(typeof r.json?.error?.message, 'string', 'error.message 应是字符串');
}
const E = { 400: 'validation_failed', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
/** expectError 的简写：fail(r, 409) 等价于 expectError(r, 409, 'conflict') */
export const fail = (r, status) => expectError(r, status, E[status]);

export const get = async (url, as) => ok(await req('GET', url, undefined, { as }));
export const post = async (url, body, as) => ok(await req('POST', url, body, { as }), 201);
/** 操作类 POST（/approve、/pay 这类）返回 200 */
export const act = async (url, body, as) => ok(await req('POST', url, body ?? {}, { as }));
export const patch = async (url, body, as) => ok(await req('PATCH', url, body, { as }));
export const put = async (url, body, as) => ok(await req('PUT', url, body, { as }));
export async function del(url, as) { const r = await req('DELETE', url, undefined, { as }); assert.equal(r.status, 204, `期望 204，实际 ${brief(r)}`); }
/** 分页列表：断言 {items,total,page,page_size} 并返回 items */
export async function list(url, as) {
  const r = await get(url, as);
  assert.ok(r && Array.isArray(r.items) && typeof r.total === 'number', `分页列表应是 {items,total,page,page_size}，实际 ${JSON.stringify(r)?.slice(0, 160)}`);
  return r.items;
}
export async function login(username, password) {
  const r = ok(await req('POST', '/api/auth/login', { username, password }, { as: null }));
  assert.equal(typeof r.token, 'string');
  return r.token;
}
/** 断言数组里每项的某个字段依次等于 expected */
export function pluck(arr, key) { return arr.map((x) => x[key]); }

// —— 北京时间 ——
const BJ = 8 * 3600_000;
/** 今天加 n 天的北京日期 YYYY-MM-DD */
export function day(n = 0) { return new Date(Date.now() + BJ + n * 86400_000).toISOString().slice(0, 10); }
export function addDays(date, n) { return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10); }
/** 1–7，1 是星期一 */
export function weekday(date) { const w = new Date(`${date}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; }
export const month = (date) => date.slice(0, 7);
/** 北京时间现在的 HH:MM */
export function nowHM() { return new Date(Date.now() + BJ).toISOString().slice(11, 16); }
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

// —— 造数据 ——
let seq = 0;
const n = () => ++seq;
const users = {}; // username → { user, token, password }
// 上课时刻轮流取下面的时段（课程默认 45 分钟一节，相邻时段不重叠）。不同班级只要教师、教室、学员都不同，同一时段也不冲突；
// 同一个学员要上几个班时，在本期内连续取 fx.slot()（19 个以内不会重复）或直接给 startTime。
let slotIndex = 0;
const SLOTS = ['07:00', '07:50', '08:40', '09:30', '10:20', '11:10', '12:00', '12:50', '13:40', '14:30', '15:20', '16:10', '17:00', '17:50', '18:40', '19:30', '20:20', '21:10', '22:00'];

export const fx = {
  /** 下一个空闲的上课时刻（45 分钟一节不重叠） */
  slot() { return SLOTS[slotIndex++ % SLOTS.length]; },
  /** 新建用户并登录；返回 { user, token, password } */
  async user(role, extra = {}) {
    const username = `${role}_${n()}`;
    const password = 'pass1234';
    const user = await post('/api/users', { username, password, name: extra.name ?? `${role}${seq}`, role, ...extra });
    const token = await login(username, password);
    return (users[username] = { user, token, password });
  },
  async campus(extra = {}) { const k = n(); return post('/api/campuses', { code: `C${k}`, name: `校区${k}`, ...extra }); },
  async room(campusId, extra = {}) { const k = n(); return post('/api/rooms', { campus_id: campusId, name: `R${k}`, capacity: 30, ...extra }); },
  async subject(extra = {}) { const k = n(); return post('/api/subjects', { name: `科目${k}`, ...extra }); },
  /** 默认：班课、45 分钟、每节 10000 分（100 元）、默认 20 课时、每班最多 20 人、1–12 年级 */
  async course(subjectId, extra = {}) {
    const k = n();
    return post('/api/courses', { code: `K-${k}`, name: `课程${k}`, subject_id: subjectId, type: 'group', lesson_minutes: 45, price_per_lesson: 10000, default_lessons: 20, max_students: 20, grade_min: 1, grade_max: 12, ...extra });
  },
  /** 教师档案；withUser 时同时建一个 teacher 用户并绑定。返回 { teacher, user, token } */
  async teacher(campusId, subjectIds, { withUser = true, ...extra } = {}) {
    const u = withUser ? await fx.user('teacher') : null;
    const k = n();
    const teacher = await post('/api/teachers', { user_id: u?.user.id ?? null, name: `教师${k}`, campus_id: campusId, subject_ids: subjectIds, employment: 'full_time', pay_per_lesson: 5000, ...extra });
    return { teacher, user: u?.user ?? null, token: u?.token ?? null };
  },
  async student(campusId, extra = {}) { const k = n(); return post('/api/students', { name: `学员${k}`, campus_id: campusId, grade: 4, ...extra }); },
  /** 家长用户并绑定这些学员；返回 { user, token } */
  async parentOf(studentIds, relation = 'mother') {
    const p = await fx.user('parent');
    for (const id of studentIds) await post(`/api/students/${id}/guardians`, { user_id: p.user.id, relation });
    return p;
  },
  /** 下单并按应付金额支付；items 是 [{course_id, lessons}] */
  async paidOrder(studentId, items, { method = 'cash', discount_id = null, as } = {}) {
    const order = await post('/api/orders', { student_id: studentId, items, discount_id, note: '' }, as);
    return act(`/api/orders/${order.id}/pay`, { method, amount: order.payable_amount }, as);
  },
  /**
   * 新建并发布班级，返回 { cls, lessons }（lessons 按日期升序，取自 GET /api/lessons）。
   * 默认每天一节（schedule 是全部 7 天）、从 startDate 开始 lessonCount 节、时刻用 fx.slot()。
   */
  async publishedClass({ course, campusId, roomId, teacherId, startDate, lessonCount, weekdays = ALL_WEEKDAYS, startTime, capacity = 10, termId = null, name }) {
    const t = startTime ?? fx.slot();
    const cls = await post('/api/classes', {
      name: name ?? `班级${n()}`, course_id: course.id, campus_id: campusId, room_id: roomId, teacher_id: teacherId, term_id: termId,
      capacity, start_date: startDate, schedule: weekdays.map((w) => ({ weekday: w, start_time: t })), lesson_count: lessonCount,
    });
    const published = await act(`/api/classes/${cls.id}/publish`);
    return { cls: published, lessons: await fx.lessonsOf(published) };
  },
  /** 一个班的全部课次（按 31 天一段分段查询） */
  async lessonsOf(cls) {
    const out = [];
    let from = cls.start_date;
    const end = cls.end_date ?? addDays(cls.start_date, 400);
    while (from <= end) {
      const to = addDays(from, 30) < end ? addDays(from, 30) : end;
      out.push(...await get(`/api/lessons?class_id=${cls.id}&from=${from}&to=${to}`));
      from = addDays(to, 1);
    }
    return out;
  },
  async enroll(classId, studentId, joinDate) { return post(`/api/classes/${classId}/students`, joinDate ? { student_id: studentId, join_date: joinDate } : { student_id: studentId }); },
  /** 点名：statusOf 是 { [student_id]: status }，没列出的应到学员记 present */
  async attend(lessonId, statusOf = {}, { content = '', as } = {}) {
    const lesson = await get(`/api/lessons/${lessonId}`, as);
    const records = lesson.roster.map((s) => ({ student_id: s.student_id, status: statusOf[s.student_id] ?? 'present' }));
    return act(`/api/lessons/${lessonId}/attendance`, { records, content }, as);
  },
  /**
   * 常用的一整套：新校区、教室、科目、课程、带用户的教师。
   * 返回 { campus, room, subject, course, teacher, teacherUser, teacherToken }。
   */
  async school(courseExtra = {}) {
    const campus = await fx.campus();
    const room = await fx.room(campus.id);
    const subject = await fx.subject();
    const course = await fx.course(subject.id, courseExtra);
    const t = await fx.teacher(campus.id, [subject.id]);
    return { campus, room, subject, course, teacher: t.teacher, teacherUser: t.user, teacherToken: t.token };
  },
};
