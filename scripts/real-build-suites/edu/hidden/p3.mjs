// 第三期：班级、发布与课次生成、课次查询、调课代课停课、分班、点名与消课、请假、补课、结课与取消、学员考勤（REQ-021–REQ-030）。
// 远期的排课用 2033 年的日期（节假日也建在 2033 年，别的文件不用这一年）；要点名的课次在今天及以前，要请假、补课目标的课次在 day(2) 及以后。
import { ALL_WEEKDAYS, act, assert, check, day, del, fail, fx, get, group, list, nowHM, ok, patch, pluck, post, put, req } from './lib.mjs';

// —— 本文件用的小工具 ——
let k = 0;
const tag = () => `${++k}t${Date.now() % 100000}`;
/** 新建 planning 的班级；s 是 fx.school() 的结果 */
async function draft(s, { course, roomId, teacherId, startDate, lessonCount, weekdays = ALL_WEEKDAYS, startTime = '09:00', schedule, capacity = 10, name } = {}) {
  return post('/api/classes', {
    name: name ?? `p3班${tag()}`, course_id: (course ?? s.course).id, campus_id: s.campus.id, room_id: roomId ?? s.room.id, teacher_id: teacherId ?? s.teacher.id, term_id: null,
    capacity, start_date: startDate, schedule: schedule ?? weekdays.map((w) => ({ weekday: w, start_time: startTime })), lesson_count: lessonCount,
  });
}
/** 新建并发布，返回 { cls, lessons } */
async function pub(s, opts) {
  const c = await draft(s, opts);
  const cls = await act(`/api/classes/${c.id}/publish`);
  return { cls, lessons: await fx.lessonsOf(cls) };
}
function at(lessons, date) { const l = lessons.find((x) => x.date === date); assert.ok(l, `没有 ${date} 的课次`); return l; }
/** 新学员并买 n 节这门课 */
async function buyer(s, n = 10, { course, discount_id } = {}) {
  const st = await fx.student(s.campus.id);
  await fx.paidOrder(st.id, [{ course_id: (course ?? s.course).id, lessons: n }], { discount_id: discount_id ?? null });
  return st;
}
const pkgs = (sid, cid) => get(`/api/students/${sid}/packages?course_id=${cid}`);
const remaining = async (sid, cid) => (await pkgs(sid, cid)).reduce((a, p) => a + p.remaining, 0);
const ledger = (sid, cid) => get(`/api/students/${sid}/ledger?course_id=${cid}`);
const attendanceOf = (lessonId) => get(`/api/lessons/${lessonId}/attendance`);
const recs = (pairs) => pairs.map(([sid, status]) => ({ student_id: sid, status }));
const rosterIds = async (lessonId) => pluck((await get(`/api/lessons/${lessonId}`)).roster, 'student_id');
/** 立减 value 分的优惠（用来让课时包的 paid_amount 不能被课时数整除） */
const discountOff = (value) => post('/api/discounts', { name: `p3减${tag()}`, type: 'amount', value, min_amount: 0, valid_from: null, valid_to: null });
const otherTeacher = (s, extra) => fx.teacher(s.campus.id, [s.subject.id], extra);

export async function run() {
  const ctx = {};

  group('三期·班级');
  await check('创建班级：code 是 CL 加 6 位序号且递增；status planning、end_date null、cancel_reason ""、student_count 0；带课程、教师、教室、校区名称，term_id 为 null 时 term_name 为 null', async () => {
    const s = await fx.school();
    const a = await draft(s, { startDate: day(2), lessonCount: 4 });
    const b = await draft(s, { startDate: day(2), lessonCount: 4, startTime: '10:00' });
    assert.match(a.code, /^CL\d{6}$/); assert.match(b.code, /^CL\d{6}$/);
    assert.ok(Number(b.code.slice(2)) > Number(a.code.slice(2)), `${a.code} → ${b.code} 应递增`);
    assert.equal(a.status, 'planning'); assert.equal(a.end_date, null); assert.equal(a.cancel_reason, ''); assert.equal(a.student_count, 0);
    assert.equal(a.course_name, s.course.name); assert.equal(a.teacher_name, s.teacher.name); assert.equal(a.room_name, s.room.name); assert.equal(a.campus_name, s.campus.name);
    assert.equal(a.term_id, null); assert.equal(a.term_name, null);
    assert.deepEqual(a.schedule.map((x) => ({ weekday: x.weekday, start_time: x.start_time })), [{ weekday: 1, start_time: '09:00' }, { weekday: 2, start_time: '09:00' }, { weekday: 3, start_time: '09:00' }, { weekday: 4, start_time: '09:00' }, { weekday: 5, start_time: '09:00' }, { weekday: 6, start_time: '09:00' }, { weekday: 7, start_time: '09:00' }]);
  });
  await check('班级校验 400：教室不属于这个校区、教师不能教这门课的科目、容量超过课程 max_students 或教室容量、容量为 0、lesson_count 不在 1–200', async () => {
    const s = await fx.school(); // 课程 max_students 20，教室容量 30
    const otherCampus = await fx.campus();
    const otherRoom = await fx.room(otherCampus.id);
    const otherSubject = await fx.subject();
    const t2 = await fx.teacher(s.campus.id, [otherSubject.id], { withUser: false });
    const small = await fx.room(s.campus.id, { capacity: 5 });
    const base = { name: `p3班${tag()}`, course_id: s.course.id, campus_id: s.campus.id, room_id: s.room.id, teacher_id: s.teacher.id, term_id: null, capacity: 10, start_date: day(2), schedule: [{ weekday: 1, start_time: '09:00' }], lesson_count: 4 };
    for (const bad of [{ room_id: otherRoom.id }, { teacher_id: t2.teacher.id }, { capacity: 21 }, { room_id: small.id, capacity: 6 }, { capacity: 0 }, { lesson_count: 0 }, { lesson_count: 201 }, { name: '  ' }]) {
      fail(await req('POST', '/api/classes', { ...base, ...bad }), 400);
    }
    ok(await req('POST', '/api/classes', { ...base, room_id: small.id, capacity: 5 }), 201);
    ok(await req('POST', '/api/classes', { ...base, capacity: 20 }), 201);
  });
  await check('schedule 校验：为空、同一 weekday 两条、weekday 越界、时刻格式不对都是 400；下课晚于 24:00 400，正好 24:00（23:15 开始 45 分钟）可以', async () => {
    const s = await fx.school();
    const base = { name: `p3班${tag()}`, course_id: s.course.id, campus_id: s.campus.id, room_id: s.room.id, teacher_id: s.teacher.id, term_id: null, capacity: 10, start_date: day(2), lesson_count: 4 };
    for (const schedule of [[], [{ weekday: 1, start_time: '09:00' }, { weekday: 1, start_time: '10:00' }], [{ weekday: 8, start_time: '09:00' }], [{ weekday: 0, start_time: '09:00' }], [{ weekday: 1, start_time: '9:00' }], [{ weekday: 1, start_time: '23:30' }]]) {
      fail(await req('POST', '/api/classes', { ...base, schedule }), 400);
    }
    ok(await req('POST', '/api/classes', { ...base, schedule: [{ weekday: 1, start_time: '23:15' }] }), 201);
  });
  await check('planning 的班级可以 PATCH 可写字段（校验同创建），可以删除（204，之后 404）', async () => {
    const s = await fx.school();
    const c = await draft(s, { startDate: day(2), lessonCount: 4 });
    const p = await patch(`/api/classes/${c.id}`, { capacity: 15, lesson_count: 8, schedule: [{ weekday: 2, start_time: '10:00' }] });
    assert.equal(p.capacity, 15); assert.equal(p.lesson_count, 8); assert.deepEqual(p.schedule.map((x) => [x.weekday, x.start_time]), [[2, '10:00']]);
    fail(await req('PATCH', `/api/classes/${c.id}`, { capacity: 21 }), 400);
    await del(`/api/classes/${c.id}`);
    fail(await req('GET', `/api/classes/${c.id}`), 404);
  });
  await check('active 的班级只能改 name：改 name 生效，改 capacity、lesson_count 409', async () => {
    const s = await fx.school();
    const { cls } = await pub(s, { startDate: day(2), lessonCount: 2 });
    assert.equal((await patch(`/api/classes/${cls.id}`, { name: '改名后的班' })).name, '改名后的班');
    fail(await req('PATCH', `/api/classes/${cls.id}`, { capacity: 12 }), 409);
    fail(await req('PATCH', `/api/classes/${cls.id}`, { lesson_count: 5 }), 409);
    assert.equal((await get(`/api/classes/${cls.id}`)).capacity, 10);
  });
  await check('GET /api/classes：course_id、status、teacher_id、q（名称或编号）筛选，按 id 降序', async () => {
    const s = await fx.school();
    const a = await draft(s, { startDate: day(2), lessonCount: 2 });
    const { cls: b } = await pub(s, { startDate: day(2), lessonCount: 2, startTime: '11:00' });
    assert.deepEqual(pluck(await list(`/api/classes?course_id=${s.course.id}`), 'id'), [b.id, a.id]);
    assert.deepEqual(pluck(await list(`/api/classes?course_id=${s.course.id}&status=active`), 'id'), [b.id]);
    assert.deepEqual(pluck(await list(`/api/classes?course_id=${s.course.id}&status=planning`), 'id'), [a.id]);
    assert.deepEqual(pluck(await list(`/api/classes?teacher_id=${s.teacher.id}`), 'id'), [b.id, a.id]);
    assert.deepEqual(pluck(await list(`/api/classes?q=${a.code}`), 'id'), [a.id]);
    assert.deepEqual(pluck(await list(`/api/classes?q=${encodeURIComponent(b.name)}`), 'id'), [b.id]);
  });
  await check('权限：sales、finance 能读班级，sales 新建、发布 403；parent 读 403；teacher 列表只有自己的班级，读别人的班级 403，不能发布 403', async () => {
    const s = await fx.school();
    const c = await draft(s, { startDate: day(2), lessonCount: 2 });
    const sales = await fx.user('sales');
    const fin = await fx.user('finance');
    ok(await req('GET', `/api/classes/${c.id}`, undefined, { as: sales.token }));
    ok(await req('GET', '/api/classes', undefined, { as: fin.token }));
    fail(await req('POST', '/api/classes', { name: 'x', course_id: s.course.id, campus_id: s.campus.id, room_id: s.room.id, teacher_id: s.teacher.id, term_id: null, capacity: 5, start_date: day(2), schedule: [{ weekday: 1, start_time: '09:00' }], lesson_count: 2 }, { as: sales.token }), 403);
    fail(await req('POST', `/api/classes/${c.id}/publish`, {}, { as: sales.token }), 403);
    const p = await fx.user('parent');
    fail(await req('GET', '/api/classes', undefined, { as: p.token }), 403);
    const mine = await list('/api/classes?page_size=100', s.teacherToken);
    assert.ok(mine.some((x) => x.id === c.id)); assert.ok(mine.every((x) => x.teacher_id === s.teacher.id));
    fail(await req('POST', `/api/classes/${c.id}/publish`, {}, { as: s.teacherToken }), 403);
    const other = await otherTeacher(s);
    fail(await req('GET', `/api/classes/${c.id}`, undefined, { as: other.token }), 403);
    assert.equal((await get(`/api/classes/${c.id}`)).status, 'planning');
  });

  group('三期·发布与课次生成');
  await check('发布：从 start_date 逐日往后，遇到 schedule 的星期按那天的时刻排一节，跳过节假日；seq 从 1 起；填 end_date，→ active', async () => {
    await post('/api/holidays', { date: '2033-03-10', name: 'p3假日' });
    const s = await fx.school();
    // 2033-03-02 是星期三；星期一 09:00、星期四 14:00；2033-03-10（星期四）是节假日
    const c = await draft(s, { startDate: '2033-03-02', lessonCount: 5, schedule: [{ weekday: 4, start_time: '14:00' }, { weekday: 1, start_time: '09:00' }] });
    const p = await act(`/api/classes/${c.id}/publish`);
    assert.equal(p.status, 'active'); assert.equal(p.end_date, '2033-03-21');
    const ls = await fx.lessonsOf(p);
    assert.deepEqual(ls.map((l) => [l.seq, l.date, l.start_time, l.end_time]), [
      [1, '2033-03-03', '14:00', '14:45'], [2, '2033-03-07', '09:00', '09:45'], [3, '2033-03-14', '09:00', '09:45'], [4, '2033-03-17', '14:00', '14:45'], [5, '2033-03-21', '09:00', '09:45'],
    ]);
    for (const l of ls) {
      assert.equal(l.class_id, c.id); assert.equal(l.teacher_id, s.teacher.id); assert.equal(l.room_id, s.room.id); assert.equal(l.status, 'scheduled');
      assert.equal(l.original_teacher_id, null); assert.equal(l.cancel_reason, ''); assert.equal(l.content, '');
    }
    ctx.gen = { s, cls: p, lessons: ls };
  });
  await check('已发布的班级再发布 409；发布后再加的节假日不改变已经排好的课次', async () => {
    const { cls, lessons } = ctx.gen;
    fail(await req('POST', `/api/classes/${cls.id}/publish`, {}), 409);
    await post('/api/holidays', { date: '2033-03-14', name: 'p3假日2' });
    const now = await fx.lessonsOf(await get(`/api/classes/${cls.id}`));
    assert.deepEqual(now.map((l) => [l.id, l.seq, l.date, l.status]), lessons.map((l) => [l.id, l.seq, l.date, l.status]));
  });
  await check('冲突：与同一教师的未取消课次时间重叠 → 409，message 写明第一处冲突的日期；整个发布失败（班级仍是 planning、end_date null、没有任何课次）', async () => {
    const s = await fx.school();
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '10:00' });
    // B：2033-06-27 不冲突，2033-07-04 10:30 与 A 的 10:00–10:45 重叠
    const B = await draft(s, { roomId: room2.id, startDate: '2033-06-27', lessonCount: 2, weekdays: [1], startTime: '10:30' });
    const r = await req('POST', `/api/classes/${B.id}/publish`, {});
    fail(r, 409);
    assert.match(r.json.error.message, /2033-07-04|7\s*月\s*0?4\s*日/, `message 应写明冲突日期：${r.json.error.message}`);
    const b = await get(`/api/classes/${B.id}`);
    assert.equal(b.status, 'planning'); assert.equal(b.end_date, null);
    assert.deepEqual(await get(`/api/lessons?class_id=${B.id}`), []);
    ctx.conflict = { A, B };
  });
  await check('已取消的课次不算冲突：停掉冲突的那一节后，原来发布失败的班级可以发布', async () => {
    const { A, B } = ctx.conflict;
    await act(`/api/lessons/${A.lessons[0].id}/cancel`, { reason: '让出时间' });
    const b = await act(`/api/classes/${B.id}/publish`);
    assert.equal(b.status, 'active'); assert.equal(b.end_date, '2033-07-04');
    assert.equal((await fx.lessonsOf(b)).length, 2);
  });
  await check('首尾相接不算冲突：同一教师、同一教室紧接在后（10:45 开始）、紧挨在前（09:15 开始 10:00 下课）都能发布', async () => {
    const s = await fx.school();
    await pub(s, { startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '10:00' });
    assert.equal((await pub(s, { startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '10:45' })).cls.status, 'active');
    assert.equal((await pub(s, { startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '09:15' })).cls.status, 'active');
  });
  await check('冲突：与同一教室的课次重叠（不同教师）→ 409', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s, { withUser: false });
    await pub(s, { startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '10:00' });
    const B = await draft(s, { teacherId: t2.teacher.id, startDate: '2033-07-04', lessonCount: 1, weekdays: [1], startTime: '10:20' });
    fail(await req('POST', `/api/classes/${B.id}/publish`, {}), 409);
    assert.equal((await get(`/api/classes/${B.id}`)).status, 'planning');
  });
  await check('教师设置了可上课时间：课次必须完全落在当天某个时段内，否则 409（超出时段末尾、当天没有时段）；正好到时段末尾可以', async () => {
    const s = await fx.school();
    await put(`/api/teachers/${s.teacher.id}/availability`, { slots: [{ weekday: 1, start: '08:00', end: '12:00' }] });
    const late = await draft(s, { startDate: '2033-08-01', lessonCount: 1, weekdays: [1], startTime: '11:30' });
    fail(await req('POST', `/api/classes/${late.id}/publish`, {}), 409);
    const tue = await draft(s, { startDate: '2033-08-02', lessonCount: 1, weekdays: [2], startTime: '09:00' });
    fail(await req('POST', `/api/classes/${tue.id}/publish`, {}), 409);
    const fits = await draft(s, { startDate: '2033-08-01', lessonCount: 1, weekdays: [1], startTime: '11:15' });
    assert.equal((await act(`/api/classes/${fits.id}/publish`)).status, 'active');
  });
  await check('发布时教师或教室已停用 → 409；恢复启用后可以发布', async () => {
    const s = await fx.school();
    const c = await draft(s, { startDate: '2033-05-02', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    await patch(`/api/teachers/${s.teacher.id}`, { active: false });
    fail(await req('POST', `/api/classes/${c.id}/publish`, {}), 409);
    await patch(`/api/teachers/${s.teacher.id}`, { active: true });
    await patch(`/api/rooms/${s.room.id}`, { active: false });
    fail(await req('POST', `/api/classes/${c.id}/publish`, {}), 409);
    await patch(`/api/rooms/${s.room.id}`, { active: true });
    assert.equal((await act(`/api/classes/${c.id}/publish`)).status, 'active');
  });

  group('三期·课次查询');
  await check('GET /api/lessons：没有 class_id 时必须给 from、to；to 早于 from、相差超过 31 天、日期不存在都是 400；给了 class_id 可以不给 from、to', async () => {
    fail(await req('GET', '/api/lessons'), 400);
    fail(await req('GET', '/api/lessons?from=2033-01-01'), 400);
    fail(await req('GET', '/api/lessons?from=2033-01-10&to=2033-01-09'), 400);
    fail(await req('GET', '/api/lessons?from=2033-01-01&to=2033-02-02'), 400);
    fail(await req('GET', '/api/lessons?from=2033-02-30&to=2033-03-01'), 400);
    assert.ok(Array.isArray(await get('/api/lessons?from=2033-01-01&to=2033-02-01'))); // 正好 31 天可以
    const all = await get(`/api/lessons?class_id=${ctx.gen.cls.id}`);
    assert.deepEqual(pluck(all, 'id'), pluck(ctx.gen.lessons, 'id'));
    // 给了 class_id 时 from、to 不限制相差天数
    assert.deepEqual(pluck(await get(`/api/lessons?class_id=${ctx.gen.cls.id}&from=2033-01-01&to=2033-12-31`), 'id'), pluck(ctx.gen.lessons, 'id'));
  });
  await check('课次列表按 date、start_time 升序（不分页，数组），每项另带 class_name、course_id、course_name、teacher_name、original_teacher_name、room_name、campus_id、campus_name', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s);
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: day(-1), lessonCount: 3, startTime: '10:20' });
    const B = await pub(s, { teacherId: t2.teacher.id, roomId: room2.id, startDate: day(-1), lessonCount: 3, startTime: '07:00' });
    const ls = await get(`/api/lessons?campus_id=${s.campus.id}&from=${day(-1)}&to=${day(1)}`);
    const expected = [];
    for (const d of [day(-1), day(0), day(1)]) expected.push(at(B.lessons, d).id, at(A.lessons, d).id);
    assert.deepEqual(pluck(ls, 'id'), expected);
    const l = ls[0];
    assert.equal(l.class_name, B.cls.name); assert.equal(l.course_id, s.course.id); assert.equal(l.course_name, s.course.name);
    assert.equal(l.teacher_name, t2.teacher.name); assert.equal(l.original_teacher_name, null); assert.equal(l.room_name, room2.name);
    assert.equal(l.campus_id, s.campus.id); assert.equal(l.campus_name, s.campus.name);
    ctx.q = { s, t2, room2, A, B };
  });
  await check('课次列表筛选：teacher_id、room_id、class_id、course_id、status', async () => {
    const { s, t2, room2, A, B } = ctx.q;
    const range = `from=${day(-1)}&to=${day(1)}`;
    assert.deepEqual(pluck(await get(`/api/lessons?teacher_id=${t2.teacher.id}&${range}`), 'id'), pluck(B.lessons, 'id'));
    assert.deepEqual(pluck(await get(`/api/lessons?room_id=${s.room.id}&${range}`), 'id'), pluck(A.lessons, 'id'));
    assert.deepEqual(pluck(await get(`/api/lessons?room_id=${room2.id}&${range}`), 'id'), pluck(B.lessons, 'id'));
    assert.deepEqual(pluck(await get(`/api/lessons?class_id=${A.cls.id}&${range}`), 'id'), pluck(A.lessons, 'id'));
    assert.equal((await get(`/api/lessons?course_id=${s.course.id}&${range}`)).length, 6);
    const b1 = at(B.lessons, day(1));
    await act(`/api/lessons/${b1.id}/cancel`, { reason: '筛选用' });
    assert.deepEqual(pluck(await get(`/api/lessons?campus_id=${s.campus.id}&status=cancelled&${range}`), 'id'), [b1.id]);
    assert.equal((await get(`/api/lessons?campus_id=${s.campus.id}&status=scheduled&${range}`)).length, 5);
  });
  await check('GET /api/lessons/:id 带 roster（student_id、name、no、source=class、attendance null、leave_status null、remaining 是这门课的课时余额），按 student_id 升序；不存在的课次 404', async () => {
    const { s, A } = ctx.q;
    const s1 = await buyer(s, 5);
    const s2 = await buyer(s, 3);
    await fx.enroll(A.cls.id, s1.id, day(-1));
    await fx.enroll(A.cls.id, s2.id, day(-1));
    const l = await get(`/api/lessons/${at(A.lessons, day(0)).id}`);
    assert.equal(l.class_name, A.cls.name);
    assert.deepEqual(l.roster.map((r) => [r.student_id, r.name, r.no, r.source, r.attendance, r.leave_status, r.remaining]), [
      [s1.id, s1.name, s1.no, 'class', null, null, 5], [s2.id, s2.name, s2.no, 'class', null, null, 3],
    ]);
    fail(await req('GET', '/api/lessons/9999999'), 404);
  });
  await check('teacher 只看到自己的课次，读别人的课次 403；parent 查课次 403', async () => {
    const { s, t2, A, B } = ctx.q;
    const mine = await get(`/api/lessons?from=${day(-1)}&to=${day(1)}`, s.teacherToken);
    assert.ok(mine.every((l) => l.teacher_id === s.teacher.id));
    assert.deepEqual(pluck(mine, 'id'), pluck(A.lessons, 'id'));
    ok(await req('GET', `/api/lessons/${B.lessons[0].id}`, undefined, { as: t2.token }));
    fail(await req('GET', `/api/lessons/${A.lessons[0].id}`, undefined, { as: t2.token }), 403);
    const p = await fx.user('parent');
    fail(await req('GET', `/api/lessons?from=${day(-1)}&to=${day(1)}`, undefined, { as: p.token }), 403);
  });

  group('三期·调课、代课与停课');
  await check('调课：改日期、时刻与教室（同校区），end_time 按课程时长；不给 room_id 时教室不变；与这节课自己原来的时间重叠不算冲突', async () => {
    const s = await fx.school();
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-09-05', lessonCount: 2, weekdays: [1], startTime: '09:00' }); // 09-05、09-12
    const [l1, l2] = A.lessons;
    const r = await act(`/api/lessons/${l1.id}/reschedule`, { date: '2033-09-06', start_time: '10:00', room_id: room2.id });
    assert.equal(r.id, l1.id); assert.equal(r.date, '2033-09-06'); assert.equal(r.start_time, '10:00'); assert.equal(r.end_time, '10:45');
    assert.equal(r.room_id, room2.id); assert.equal(r.status, 'scheduled'); assert.equal(r.seq, 1);
    const r2 = await act(`/api/lessons/${l2.id}/reschedule`, { date: '2033-09-12', start_time: '09:15' });
    assert.equal(r2.start_time, '09:15'); assert.equal(r2.end_time, '10:00'); assert.equal(r2.room_id, s.room.id);
    ctx.rs = { s, room2, l2 };
  });
  await check('调课冲突：换到别的校区的教室 400；新时间与同一教师或同一教室的课次重叠 409，课次不变', async () => {
    const { s, room2, l2 } = ctx.rs;
    const far = await fx.room((await fx.campus()).id);
    fail(await req('POST', `/api/lessons/${l2.id}/reschedule`, { date: '2033-09-20', start_time: '09:00', room_id: far.id }), 400);
    await pub(s, { roomId: room2.id, startDate: '2033-09-13', lessonCount: 1, weekdays: [2], startTime: '14:00' }); // 同一教师
    fail(await req('POST', `/api/lessons/${l2.id}/reschedule`, { date: '2033-09-13', start_time: '14:30', room_id: s.room.id }), 409);
    const t2 = await otherTeacher(s, { withUser: false });
    await pub(s, { teacherId: t2.teacher.id, startDate: '2033-09-14', lessonCount: 1, weekdays: [3], startTime: '08:00' }); // 同一教室
    fail(await req('POST', `/api/lessons/${l2.id}/reschedule`, { date: '2033-09-14', start_time: '08:30' }), 409);
    const now = await get(`/api/lessons/${l2.id}`);
    assert.equal(now.date, '2033-09-12'); assert.equal(now.start_time, '09:15');
  });
  await check('调课：这节课的应到学员在新时间有别的班级课次 → 409；错开（首尾相接）可以', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s, { withUser: false });
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-10-03', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    const B = await pub(s, { teacherId: t2.teacher.id, roomId: room2.id, startDate: '2033-10-04', lessonCount: 1, weekdays: [2], startTime: '15:00' });
    const st = await buyer(s, 4);
    await fx.enroll(A.cls.id, st.id); await fx.enroll(B.cls.id, st.id);
    fail(await req('POST', `/api/lessons/${A.lessons[0].id}/reschedule`, { date: '2033-10-04', start_time: '15:30' }), 409);
    const r = await act(`/api/lessons/${A.lessons[0].id}/reschedule`, { date: '2033-10-04', start_time: '15:45' });
    assert.equal(r.date, '2033-10-04'); assert.equal(r.start_time, '15:45');
  });
  await check('调课：教师设置了可上课时间时，新时间不在当天的时段内 409，在时段内可以', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: '2033-10-03', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    await put(`/api/teachers/${s.teacher.id}/availability`, { slots: [{ weekday: 1, start: '08:00', end: '12:00' }] });
    const id = A.lessons[0].id;
    fail(await req('POST', `/api/lessons/${id}/reschedule`, { date: '2033-10-03', start_time: '11:30' }), 409);
    fail(await req('POST', `/api/lessons/${id}/reschedule`, { date: '2033-10-04', start_time: '09:00' }), 409);
    assert.equal((await act(`/api/lessons/${id}/reschedule`, { date: '2033-10-10', start_time: '11:00' })).date, '2033-10-10');
  });
  await check('代课：新教师不能教这门课的科目或已停用 400；成功后 teacher_id 是代课教师、original_teacher_id 记最初的教师，再换一位仍是最初的，换回最初的教师时清空', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: '2033-11-07', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    const id = A.lessons[0].id;
    const t2 = await otherTeacher(s, { withUser: false });
    const t3 = await otherTeacher(s, { withUser: false });
    const wrong = await fx.teacher(s.campus.id, [(await fx.subject()).id], { withUser: false });
    const off = await otherTeacher(s, { withUser: false });
    await patch(`/api/teachers/${off.teacher.id}`, { active: false });
    fail(await req('POST', `/api/lessons/${id}/substitute`, { teacher_id: wrong.teacher.id }), 400);
    fail(await req('POST', `/api/lessons/${id}/substitute`, { teacher_id: off.teacher.id }), 400);
    const r = await act(`/api/lessons/${id}/substitute`, { teacher_id: t2.teacher.id });
    assert.equal(r.teacher_id, t2.teacher.id); assert.equal(r.original_teacher_id, s.teacher.id);
    assert.equal(r.teacher_name, t2.teacher.name); assert.equal(r.original_teacher_name, s.teacher.name);
    const r2 = await act(`/api/lessons/${id}/substitute`, { teacher_id: t3.teacher.id });
    assert.equal(r2.teacher_id, t3.teacher.id); assert.equal(r2.original_teacher_id, s.teacher.id);
    const r3 = await act(`/api/lessons/${id}/substitute`, { teacher_id: s.teacher.id });
    assert.equal(r3.teacher_id, s.teacher.id); assert.equal(r3.original_teacher_id, null); assert.equal(r3.original_teacher_name, null);
  });
  await check('代课：代课教师那个时间有课 409；代课后课次属于代课教师（他能看到，最初的教师读 403）', async () => {
    const s = await fx.school();
    const busy = await otherTeacher(s, { withUser: false });
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-11-07', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    await pub(s, { teacherId: busy.teacher.id, roomId: room2.id, startDate: '2033-11-07', lessonCount: 1, weekdays: [1], startTime: '09:30' });
    const id = A.lessons[0].id;
    fail(await req('POST', `/api/lessons/${id}/substitute`, { teacher_id: busy.teacher.id }), 409);
    assert.equal((await get(`/api/lessons/${id}`)).teacher_id, s.teacher.id);
    const sub = await otherTeacher(s);
    await act(`/api/lessons/${id}/substitute`, { teacher_id: sub.teacher.id });
    ok(await req('GET', `/api/lessons/${id}`, undefined, { as: sub.token }));
    assert.ok(pluck(await get('/api/lessons?from=2033-11-07&to=2033-11-07', sub.token), 'id').includes(id));
    fail(await req('GET', `/api/lessons/${id}`, undefined, { as: s.teacherToken }), 403);
  });
  await check('停课：→ cancelled，记 cancel_reason（去掉首尾空白）；append 默认 false 时不补课、end_date 不变；reason 为空或超过 200 字 400；已取消的再停 409', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: '2033-12-05', lessonCount: 2, weekdays: [1], startTime: '09:00' }); // 12-05、12-12
    const id = A.lessons[0].id;
    fail(await req('POST', `/api/lessons/${id}/cancel`, { reason: '  ' }), 400);
    fail(await req('POST', `/api/lessons/${id}/cancel`, { reason: 'x'.repeat(201) }), 400);
    const r = await act(`/api/lessons/${id}/cancel`, { reason: ' 老师生病 ' });
    assert.equal(r.status, 'cancelled'); assert.equal(r.cancel_reason, '老师生病');
    const cls = await get(`/api/classes/${A.cls.id}`);
    assert.equal(cls.end_date, '2033-12-12');
    assert.equal((await fx.lessonsOf(cls)).length, 2);
    fail(await req('POST', `/api/lessons/${id}/cancel`, { reason: '再停' }), 409);
  });
  await check('停课顺延（append）：在最后一节未取消的课之后按 schedule 补一节、跳过节假日；seq 接着最大的编号，更新 end_date，lesson_count 不变', async () => {
    await post('/api/holidays', { date: '2033-04-25', name: 'p3假日3' });
    const s = await fx.school();
    const A = await pub(s, { startDate: '2033-04-04', lessonCount: 3, weekdays: [1], startTime: '09:00' }); // 04-04、04-11、04-18
    assert.equal(A.cls.end_date, '2033-04-18');
    await act(`/api/lessons/${at(A.lessons, '2033-04-11').id}/cancel`, { reason: '顺延', append: true });
    const cls = await get(`/api/classes/${A.cls.id}`);
    assert.equal(cls.end_date, '2033-05-02'); assert.equal(cls.lesson_count, 3);
    const ls = await fx.lessonsOf(cls);
    assert.deepEqual(ls.map((l) => [l.seq, l.date, l.start_time, l.status]), [
      [1, '2033-04-04', '09:00', 'scheduled'], [2, '2033-04-11', '09:00', 'cancelled'], [3, '2033-04-18', '09:00', 'scheduled'], [4, '2033-05-02', '09:00', 'scheduled'],
    ]);
  });
  await check('停课顺延：停的是最后一节时，补在停课前最后一节未取消的课（就是被停的这节）之后', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: '2033-05-09', lessonCount: 3, weekdays: [1], startTime: '09:00' }); // 05-09、05-16、05-23（星期一）
    await act(`/api/lessons/${at(A.lessons, '2033-05-23').id}/cancel`, { reason: '顺延', append: true });
    const cls = await get(`/api/classes/${A.cls.id}`);
    assert.equal(cls.end_date, '2033-05-30');
    assert.deepEqual((await fx.lessonsOf(cls)).map((l) => [l.seq, l.date, l.status]), [
      [1, '2033-05-09', 'scheduled'], [2, '2033-05-16', 'scheduled'], [3, '2033-05-23', 'cancelled'], [4, '2033-05-30', 'scheduled'],
    ]);
  });
  await check('停课顺延补的那一节有冲突 → 409，整个停课不生效（原课次仍是 scheduled，没有新课次，end_date 不变）', async () => {
    const s = await fx.school();
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-06-06', lessonCount: 2, weekdays: [1], startTime: '09:00' }); // 06-06、06-13
    await pub(s, { roomId: room2.id, startDate: '2033-06-20', lessonCount: 1, weekdays: [1], startTime: '09:00' }); // 同一教师占了 06-20
    fail(await req('POST', `/api/lessons/${A.lessons[0].id}/cancel`, { reason: '顺延', append: true }), 409);
    assert.equal((await get(`/api/lessons/${A.lessons[0].id}`)).status, 'scheduled');
    const cls = await get(`/api/classes/${A.cls.id}`);
    assert.equal(cls.end_date, '2033-06-13');
    assert.equal((await get(`/api/lessons?class_id=${A.cls.id}`)).length, 2);
  });
  await check('只能处理 scheduled 且还没开始的课次：已过去的、已点名的课次调课、代课、停课都是 409', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s, { withUser: false });
    const A = await pub(s, { startDate: day(-2), lessonCount: 2, startTime: '08:40' });
    const st = await buyer(s, 5);
    await fx.enroll(A.cls.id, st.id, day(-2));
    const done = at(A.lessons, day(-2));
    await fx.attend(done.id);
    for (const l of [at(A.lessons, day(-1)), done]) {
      fail(await req('POST', `/api/lessons/${l.id}/reschedule`, { date: '2033-12-20', start_time: '09:00' }), 409);
      fail(await req('POST', `/api/lessons/${l.id}/substitute`, { teacher_id: t2.teacher.id }), 409);
      fail(await req('POST', `/api/lessons/${l.id}/cancel`, { reason: '停' }), 409);
    }
    assert.equal((await get(`/api/lessons/${at(A.lessons, day(-1)).id}`)).status, 'scheduled');
  });
  await check('sales 与 teacher（自己的课次）都不能调课、代课、停课 403', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s, { withUser: false });
    const A = await pub(s, { startDate: day(3), lessonCount: 1 });
    const id = A.lessons[0].id;
    const sales = await fx.user('sales');
    fail(await req('POST', `/api/lessons/${id}/reschedule`, { date: '2033-12-20', start_time: '09:00' }, { as: sales.token }), 403);
    fail(await req('POST', `/api/lessons/${id}/cancel`, { reason: '停' }, { as: sales.token }), 403);
    fail(await req('POST', `/api/lessons/${id}/cancel`, { reason: '停' }, { as: s.teacherToken }), 403);
    fail(await req('POST', `/api/lessons/${id}/substitute`, { teacher_id: t2.teacher.id }, { as: s.teacherToken }), 403);
    assert.equal((await get(`/api/lessons/${id}`)).status, 'scheduled');
  });

  group('三期·分班');
  await check('分班返回 201，join_date 默认今天；GET 是当前在班学员，按 join_date、student_id 升序，带 remaining；班级 student_count 是在班人数', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 3 });
    const s1 = await buyer(s, 5); const s2 = await buyer(s, 3); const s3 = await buyer(s, 4);
    const r1 = await fx.enroll(A.cls.id, s1.id);
    assert.equal(r1.student_id, s1.id); assert.equal(r1.join_date, day(0));
    await fx.enroll(A.cls.id, s2.id, day(-1));
    await fx.enroll(A.cls.id, s3.id, day(0));
    const rows = await get(`/api/classes/${A.cls.id}/students`);
    assert.deepEqual(rows.map((r) => [r.student_id, r.name, r.no, r.join_date, r.remaining]), [
      [s2.id, s2.name, s2.no, day(-1), 3], [s1.id, s1.name, s1.no, day(0), 5], [s3.id, s3.name, s3.no, day(0), 4],
    ]);
    assert.equal((await get(`/api/classes/${A.cls.id}`)).student_count, 3);
  });
  await check('分班限制：planning 的班也能分；没有这门课的课时 409、inactive 学员 409、已在班里 409、满员（capacity）409', async () => {
    const s = await fx.school();
    const P = await draft(s, { startDate: day(2), lessonCount: 2, capacity: 2 });
    const s1 = await buyer(s, 2);
    ok(await req('POST', `/api/classes/${P.id}/students`, { student_id: s1.id }), 201);
    const none = await fx.student(s.campus.id);
    fail(await req('POST', `/api/classes/${P.id}/students`, { student_id: none.id }), 409);
    const otherCourse = await fx.course(s.subject.id);
    const wrong = await buyer(s, 5, { course: otherCourse });
    fail(await req('POST', `/api/classes/${P.id}/students`, { student_id: wrong.id }), 409);
    fail(await req('POST', `/api/classes/${P.id}/students`, { student_id: s1.id }), 409);
    const off = await buyer(s, 2);
    await patch(`/api/students/${off.id}`, { status: 'inactive' });
    fail(await req('POST', `/api/classes/${P.id}/students`, { student_id: off.id }), 409);
    const s2 = await buyer(s, 2);
    ok(await req('POST', `/api/classes/${P.id}/students`, { student_id: s2.id }), 201);
    const s3 = await buyer(s, 2);
    fail(await req('POST', `/api/classes/${P.id}/students`, { student_id: s3.id }), 409);
    assert.deepEqual(pluck(await get(`/api/classes/${P.id}/students`), 'student_id'), [s1.id, s2.id]);
  });
  await check('分班时间冲突：join_date 当天及以后的课次与学员已在的其他班重叠 409；join_date 晚于重叠那天就可以', async () => {
    const s = await fx.school();
    const t2 = await otherTeacher(s, { withUser: false });
    const room2 = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: '2033-02-07', lessonCount: 1, weekdays: [1], startTime: '09:00' });
    const B = await pub(s, { teacherId: t2.teacher.id, roomId: room2.id, startDate: '2033-02-07', lessonCount: 3, startTime: '09:20' }); // 02-07、02-08、02-09
    const st = await buyer(s, 4);
    await fx.enroll(A.cls.id, st.id);
    fail(await req('POST', `/api/classes/${B.cls.id}/students`, { student_id: st.id }), 409);
    ok(await req('POST', `/api/classes/${B.cls.id}/students`, { student_id: st.id, join_date: '2033-02-08' }), 201);
  });
  await check('退班 204：不在当前名单里；之前的课次仍是应到学员，今天及以后的课次不再是；同一学员可以再加入', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-2), lessonCount: 6, startTime: '10:20' }); // day(-2) … day(3)
    const st = await buyer(s, 10);
    const late = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id, day(-2));
    await fx.enroll(A.cls.id, late.id, day(2));
    await del(`/api/classes/${A.cls.id}/students/${st.id}`);
    assert.ok(!pluck(await get(`/api/classes/${A.cls.id}/students`), 'student_id').includes(st.id));
    assert.ok((await rosterIds(at(A.lessons, day(-1)).id)).includes(st.id));
    assert.ok(!(await rosterIds(at(A.lessons, day(0)).id)).includes(st.id), '退班后今天还没点名的课次也不再有这个学员');
    assert.ok(!(await rosterIds(at(A.lessons, day(2)).id)).includes(st.id));
    ok(await req('POST', `/api/classes/${A.cls.id}/students`, { student_id: st.id }), 201);
    assert.ok((await rosterIds(at(A.lessons, day(2)).id)).includes(st.id));
    ctx.en = { s, A, late };
  });
  await check('应到学员只含 join_date 不晚于课次日期的在班学员（join_date 是 day(2) 的不在 day(1) 的名单里，在 day(2) 的名单里）', async () => {
    const { A, late } = ctx.en;
    assert.ok(!(await rosterIds(at(A.lessons, day(1)).id)).includes(late.id));
    assert.ok((await rosterIds(at(A.lessons, day(2)).id)).includes(late.id));
  });
  await check('权限：teacher 能看自己班的学员名单、别人的班 403；sales 能读名单、分班 403', async () => {
    const { s, A } = ctx.en;
    ok(await req('GET', `/api/classes/${A.cls.id}/students`, undefined, { as: s.teacherToken }));
    const other = await otherTeacher(s);
    fail(await req('GET', `/api/classes/${A.cls.id}/students`, undefined, { as: other.token }), 403);
    const sales = await fx.user('sales');
    ok(await req('GET', `/api/classes/${A.cls.id}/students`, undefined, { as: sales.token }));
    const st = await buyer(s, 2);
    fail(await req('POST', `/api/classes/${A.cls.id}/students`, { student_id: st.id }, { as: sales.token }), 403);
  });

  group('三期·点名与消课');
  await check('点名：返回 200 与课次（completed、记 content、roster 的 attendance 是点名状态）；GET 按 student_id 升序给出 status、package_id、recognized_amount（leave 为 null 与 0）', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-2), lessonCount: 4, startTime: '11:10' }); // day(-2) … day(1)
    const s1 = await buyer(s, 2); const s2 = await buyer(s, 2);
    await fx.enroll(A.cls.id, s1.id, day(-2)); await fx.enroll(A.cls.id, s2.id, day(-2));
    const l = at(A.lessons, day(-2));
    const r = await act(`/api/lessons/${l.id}/attendance`, { records: recs([[s2.id, 'leave'], [s1.id, 'present']]), content: ' 分数加减 ' });
    assert.equal(r.status, 'completed'); assert.equal(r.content, '分数加减');
    assert.deepEqual(r.roster.map((x) => [x.student_id, x.attendance]), [[s1.id, 'present'], [s2.id, 'leave']]);
    const p1 = (await pkgs(s1.id, s.course.id))[0];
    // 2 节 20000 分：floor(20000 / 2) = 10000
    assert.deepEqual((await attendanceOf(l.id)).map((x) => [x.student_id, x.name, x.status, x.package_id, x.recognized_amount]), [
      [s1.id, s1.name, 'present', p1.id, 10000], [s2.id, s2.name, 'leave', null, 0],
    ]);
    ctx.at = { s, A, s1, s2 };
  });
  await check('present、late、absent 各扣 1 节（流水 consume：delta -1、ref_type attendance、ref_id 是课次编号），leave 不扣', async () => {
    const { s, A, s1, s2 } = ctx.at;
    assert.equal(await remaining(s1.id, s.course.id), 1); assert.equal(await remaining(s2.id, s.course.id), 2);
    const l0 = at(A.lessons, day(-2));
    const lg = await ledger(s1.id, s.course.id);
    assert.deepEqual(pluck(lg, 'reason'), ['purchase', 'consume']);
    const c = lg[1];
    assert.equal(c.delta, -1); assert.equal(c.ref_type, 'attendance'); assert.equal(c.ref_id, l0.id); assert.equal(c.package_id, (await pkgs(s1.id, s.course.id))[0].id);
    assert.deepEqual(pluck(await ledger(s2.id, s.course.id), 'reason'), ['purchase']);
    const l1 = at(A.lessons, day(-1));
    await act(`/api/lessons/${l1.id}/attendance`, { records: recs([[s1.id, 'late'], [s2.id, 'absent']]), content: '' });
    assert.equal(await remaining(s1.id, s.course.id), 0); assert.equal(await remaining(s2.id, s.course.id), 1);
  });
  await check('records 必须正好覆盖全部应到学员、每人一条：少人、多出不在名单里的学员、重复、status 不合法、content 超过 1000 字都是 400，课次仍是 scheduled', async () => {
    const { s, A, s1, s2 } = ctx.at;
    const l = at(A.lessons, day(0));
    const u = `/api/lessons/${l.id}/attendance`;
    const stranger = await buyer(s, 1);
    fail(await req('POST', u, { records: recs([[s1.id, 'leave']]), content: '' }), 400);
    fail(await req('POST', u, { records: recs([[s1.id, 'leave'], [s2.id, 'present'], [stranger.id, 'present']]), content: '' }), 400);
    fail(await req('POST', u, { records: recs([[s1.id, 'leave'], [s2.id, 'present'], [s2.id, 'present']]), content: '' }), 400);
    fail(await req('POST', u, { records: recs([[s1.id, 'leave'], [s2.id, 'sick']]), content: '' }), 400);
    fail(await req('POST', u, { records: recs([[s1.id, 'leave'], [s2.id, 'present']]), content: 'x'.repeat(1001) }), 400);
    assert.equal((await get(`/api/lessons/${l.id}`)).status, 'scheduled');
    assert.equal(await remaining(s2.id, s.course.id), 1);
  });
  await check('只能给 scheduled、日期不晚于今天的课次点名：明天的课 409，已点过名的再 POST 409', async () => {
    const { A, s1, s2 } = ctx.at;
    const body = { records: recs([[s1.id, 'leave'], [s2.id, 'leave']]), content: '' };
    fail(await req('POST', `/api/lessons/${at(A.lessons, day(1)).id}/attendance`, body), 409);
    fail(await req('POST', `/api/lessons/${at(A.lessons, day(-2)).id}/attendance`, body), 409);
    assert.equal((await get(`/api/lessons/${at(A.lessons, day(1)).id}`)).status, 'scheduled');
  });
  await check('消课金额：每节确认 floor(paid_amount / lessons)，扣到 remaining 为 0 的那一节确认这个包的全部剩余价值', async () => {
    const s = await fx.school();
    const d = await discountOff(1000);
    const st = await buyer(s, 3, { discount_id: d.id }); // 3 节原价 30000，立减 1000 → paid_amount 29000
    const pk = (await pkgs(st.id, s.course.id))[0];
    assert.equal(pk.paid_amount, 29000);
    const A = await pub(s, { startDate: day(-3), lessonCount: 3 });
    await fx.enroll(A.cls.id, st.id, day(-3));
    const statuses = ['present', 'late', 'absent'];
    const amounts = [];
    for (const [i, l] of A.lessons.entries()) {
      await fx.attend(l.id, { [st.id]: statuses[i] });
      amounts.push((await attendanceOf(l.id))[0].recognized_amount);
    }
    assert.deepEqual(amounts, [9666, 9666, 9668]); // floor(29000/3)=9666；最后一节 29000−2×9666=9668
    const after = (await pkgs(st.id, s.course.id))[0];
    assert.equal(after.remaining, 0); assert.equal(after.recognized_amount, 29000);
    const acc = (await get(`/api/students/${st.id}/accounts`)).find((a) => a.course_id === s.course.id);
    assert.equal(acc.consumed, 3); assert.equal(acc.remaining, 0); assert.equal(acc.remaining_value, 0);
  });
  await check('消课按课时包生成先后取最早的一个（FIFO），扣完一个再扣下一个', async () => {
    const s = await fx.school();
    const st = await buyer(s, 1); // 包 P1：1 节 10000
    await fx.paidOrder(st.id, [{ course_id: s.course.id, lessons: 2 }]); // 包 P2：2 节 20000
    const [p1, p2] = await pkgs(st.id, s.course.id);
    const A = await pub(s, { startDate: day(-2), lessonCount: 3 });
    await fx.enroll(A.cls.id, st.id, day(-2));
    const used = [];
    for (const l of A.lessons) { await fx.attend(l.id); used.push((await attendanceOf(l.id))[0].package_id); }
    assert.deepEqual(used, [p1.id, p2.id, p2.id]);
    const [q1, q2] = await pkgs(st.id, s.course.id);
    assert.deepEqual([q1.remaining, q1.recognized_amount, q2.remaining, q2.recognized_amount], [0, 10000, 0, 20000]);
  });
  await check('任何一个要扣课时的学员余额不足 → 409，整个点名不生效（别人的课时不变、课次仍是 scheduled）；那个学员记 leave 就可以点名', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-1), lessonCount: 2 }); // day(-1)、day(0)
    const x = await buyer(s, 1); const y = await buyer(s, 3);
    await fx.enroll(A.cls.id, x.id, day(-1)); await fx.enroll(A.cls.id, y.id, day(-1));
    await fx.attend(at(A.lessons, day(-1)).id);
    const l = at(A.lessons, day(0));
    fail(await req('POST', `/api/lessons/${l.id}/attendance`, { records: recs([[x.id, 'present'], [y.id, 'present']]), content: '' }), 409);
    assert.equal((await get(`/api/lessons/${l.id}`)).status, 'scheduled');
    assert.equal(await remaining(y.id, s.course.id), 2);
    assert.deepEqual(pluck(await ledger(y.id, s.course.id), 'reason'), ['purchase', 'consume']);
    await act(`/api/lessons/${l.id}/attendance`, { records: recs([[x.id, 'leave'], [y.id, 'present']]), content: '' });
    assert.equal(await remaining(y.id, s.course.id), 1); assert.equal(await remaining(x.id, s.course.id), 0);
  });
  await check('这节课有已批准请假的学员必须记 leave，否则 400；记 leave 不扣课时（用今天 23:00 还没开始的课；北京时间 22:50 以后跳过）', async () => {
    if (nowHM() >= '22:50') return;
    const s = await fx.school();
    const A = await pub(s, { startDate: day(0), lessonCount: 1, startTime: '23:00' });
    const st = await buyer(s, 2);
    await fx.enroll(A.cls.id, st.id);
    const l = A.lessons[0];
    const lv = await post('/api/leaves', { student_id: st.id, lesson_id: l.id, reason: '家里有事' });
    await act(`/api/leaves/${lv.id}/approve`, {});
    fail(await req('POST', `/api/lessons/${l.id}/attendance`, { records: recs([[st.id, 'present']]), content: '' }), 400);
    assert.equal((await get(`/api/lessons/${l.id}`)).status, 'scheduled');
    await act(`/api/lessons/${l.id}/attendance`, { records: recs([[st.id, 'leave']]), content: '' });
    assert.equal(await remaining(st.id, s.course.id), 2);
  });
  await check('权限：教师能给自己的课次点名、查看点名，给别人的课次点名 403，不能更正（PUT）403；sales 查看点名 403', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-1), lessonCount: 1 });
    const st = await buyer(s, 3);
    await fx.enroll(A.cls.id, st.id, day(-1));
    const l = A.lessons[0];
    const body = { records: recs([[st.id, 'present']]), content: '' };
    const other = await otherTeacher(s);
    fail(await req('POST', `/api/lessons/${l.id}/attendance`, body, { as: other.token }), 403);
    assert.equal((await get(`/api/lessons/${l.id}`)).status, 'scheduled');
    ok(await req('POST', `/api/lessons/${l.id}/attendance`, body, { as: s.teacherToken }));
    ok(await req('GET', `/api/lessons/${l.id}/attendance`, undefined, { as: s.teacherToken }));
    fail(await req('PUT', `/api/lessons/${l.id}/attendance`, { records: recs([[st.id, 'absent']]), content: '' }, { as: s.teacherToken }), 403);
    const sales = await fx.user('sales');
    fail(await req('GET', `/api/lessons/${l.id}/attendance`, undefined, { as: sales.token }), 403);
  });
  await check('更正（PUT）：先把原来扣的课时与确认的收入原样退回原课时包（流水 restore，delta +1），再按新状态重扣', async () => {
    const s = await fx.school();
    const d = await discountOff(1000);
    const st = await buyer(s, 3, { discount_id: d.id }); // paid_amount 29000
    const A = await pub(s, { startDate: day(-3), lessonCount: 3 }); // day(-3)、day(-2)、day(-1)
    await fx.enroll(A.cls.id, st.id, day(-3));
    for (const l of A.lessons) await fx.attend(l.id); // 9666、9666、9668
    const l0 = at(A.lessons, day(-3));
    await put(`/api/lessons/${l0.id}/attendance`, { records: recs([[st.id, 'leave']]), content: '' });
    const a = (await attendanceOf(l0.id))[0];
    assert.deepEqual([a.status, a.package_id, a.recognized_amount], ['leave', null, 0]);
    let pk = (await pkgs(st.id, s.course.id))[0];
    assert.deepEqual([pk.remaining, pk.recognized_amount], [1, 19334]); // 29000 − 9666 退回
    const lg = await ledger(st.id, s.course.id);
    const last = lg[lg.length - 1];
    assert.deepEqual([last.reason, last.delta, last.ref_type, last.ref_id, last.package_id], ['restore', 1, 'attendance', l0.id, pk.id]);
    await put(`/api/lessons/${l0.id}/attendance`, { records: recs([[st.id, 'present']]), content: '' });
    // 只剩 1 节，扣完确认全部剩余价值 29000 − 19334 = 9666
    assert.equal((await attendanceOf(l0.id))[0].recognized_amount, 9666);
    pk = (await pkgs(st.id, s.course.id))[0];
    assert.deepEqual([pk.remaining, pk.recognized_amount], [0, 29000]);
    assert.deepEqual(pluck(await ledger(st.id, s.course.id), 'reason'), ['purchase', 'consume', 'consume', 'consume', 'restore', 'consume']);
  });
  await check('更正时任何一个学员余额不足 → 409，整个更正不生效（点名记录、课时都不变）；records 不覆盖全部应到学员 400', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-2), lessonCount: 2 }); // day(-2)、day(-1)
    const x = await buyer(s, 1); const y = await buyer(s, 3);
    await fx.enroll(A.cls.id, x.id, day(-2)); await fx.enroll(A.cls.id, y.id, day(-2));
    const l0 = at(A.lessons, day(-2));
    await fx.attend(l0.id, { [x.id]: 'leave' });
    await fx.attend(at(A.lessons, day(-1)).id); // x 用掉唯一的 1 节
    const before = await attendanceOf(l0.id);
    fail(await req('PUT', `/api/lessons/${l0.id}/attendance`, { records: recs([[x.id, 'present'], [y.id, 'absent']]), content: '' }), 409);
    fail(await req('PUT', `/api/lessons/${l0.id}/attendance`, { records: recs([[y.id, 'absent']]), content: '' }), 400);
    assert.deepEqual(await attendanceOf(l0.id), before);
    assert.equal(await remaining(x.id, s.course.id), 0); assert.equal(await remaining(y.id, s.course.id), 1);
  });
  await check('只能更正已点名、7 天内的课次：还没点名的 409、9 天前的 409；6 天前的可以；点名后应到学员固定为点名时的名单', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-9), lessonCount: 4 }); // day(-9) … day(-6)
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id, day(-9));
    await fx.attend(at(A.lessons, day(-9)).id);
    await fx.attend(at(A.lessons, day(-6)).id);
    const body = { records: recs([[st.id, 'absent']]), content: '' };
    fail(await req('PUT', `/api/lessons/${at(A.lessons, day(-9)).id}/attendance`, body), 409);
    fail(await req('PUT', `/api/lessons/${at(A.lessons, day(-8)).id}/attendance`, body), 409);
    ok(await req('PUT', `/api/lessons/${at(A.lessons, day(-6)).id}/attendance`, body));
    assert.equal((await attendanceOf(at(A.lessons, day(-6)).id))[0].status, 'absent');
    assert.equal((await attendanceOf(at(A.lessons, day(-9)).id))[0].status, 'present');
    // 点名之后应到学员固定：再补录一个 join_date 是 day(-9) 的学员，已点名的课次名单不变，没点名的 day(-8) 有他
    const late = await buyer(s, 5);
    await fx.enroll(A.cls.id, late.id, day(-9));
    assert.deepEqual(await rosterIds(at(A.lessons, day(-9)).id), [st.id]);
    assert.deepEqual(await rosterIds(at(A.lessons, day(-8)).id), [st.id, late.id]);
  });

  group('三期·请假');
  await check('创建请假：201，pending，reason 去掉首尾空白；带 student_name、lesson_date、lesson_start_time、class_id、class_name、created_by_name，未审批时 reviewed_by 等为 null；课次 roster 的 leave_status 是 pending', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 6, startTime: '12:00' });
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id);
    const sales = await fx.user('sales');
    const l = at(A.lessons, day(2));
    const lv = await post('/api/leaves', { student_id: st.id, lesson_id: l.id, reason: ' 发烧 ' }, sales.token);
    assert.equal(lv.status, 'pending'); assert.equal(lv.reason, '发烧'); assert.equal(lv.review_note, '');
    assert.equal(lv.student_id, st.id); assert.equal(lv.lesson_id, l.id); assert.equal(lv.student_name, st.name);
    assert.equal(lv.lesson_date, day(2)); assert.equal(lv.lesson_start_time, '12:00'); assert.equal(lv.class_id, A.cls.id); assert.equal(lv.class_name, A.cls.name);
    assert.equal(lv.created_by, sales.user.id); assert.equal(lv.created_by_name, sales.user.name);
    assert.equal(lv.reviewed_by, null); assert.equal(lv.reviewed_by_name, null); assert.equal(lv.reviewed_at, null);
    assert.equal((await get(`/api/lessons/${l.id}`)).roster.find((r) => r.student_id === st.id).leave_status, 'pending');
    ctx.lv = { s, A, st, lv };
  });
  await check('请假校验：不是这节课的应到学员 400、reason 为空 400；已开始的课次 409、已取消的课次 409；inactive 学员 409；同一课次已有 pending 或 approved 的请假 409', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-1), lessonCount: 5, startTime: '12:50' }); // day(-1) … day(3)
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id, day(-1));
    const outsider = await buyer(s, 10);
    const L = (n) => at(A.lessons, day(n)).id;
    fail(await req('POST', '/api/leaves', { student_id: outsider.id, lesson_id: L(2), reason: '事假' }), 400);
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(2), reason: '  ' }), 400);
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(-1), reason: '事假' }), 409);
    await act(`/api/lessons/${L(3)}/cancel`, { reason: '停课' });
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(3), reason: '事假' }), 409);
    await patch(`/api/students/${st.id}`, { status: 'inactive' });
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(1), reason: '事假' }), 409);
    await patch(`/api/students/${st.id}`, { status: 'active' });
    const lv = await post('/api/leaves', { student_id: st.id, lesson_id: L(2), reason: '事假' });
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(2), reason: '又请' }), 409);
    await act(`/api/leaves/${lv.id}/approve`, {});
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: L(2), reason: '又请' }), 409);
    assert.equal((await list(`/api/leaves?student_id=${st.id}`)).length, 1);
  });
  await check('审批：批准记 status approved、review_note、reviewed_by（另带 reviewed_by_name）、reviewed_at；只能处理 pending 的，再批准或驳回 409；note 超过 200 字 400', async () => {
    const { lv } = ctx.lv;
    const ac = await fx.user('academic');
    fail(await req('POST', `/api/leaves/${lv.id}/approve`, { note: 'x'.repeat(201) }, { as: ac.token }), 400);
    const a = await act(`/api/leaves/${lv.id}/approve`, { note: ' 同意 ' }, ac.token);
    assert.equal(a.status, 'approved'); assert.equal(a.review_note, '同意');
    assert.equal(a.reviewed_by, ac.user.id); assert.equal(a.reviewed_by_name, ac.user.name); assert.equal(typeof a.reviewed_at, 'string');
    fail(await req('POST', `/api/leaves/${lv.id}/approve`, {}, { as: ac.token }), 409);
    fail(await req('POST', `/api/leaves/${lv.id}/reject`, {}, { as: ac.token }), 409);
    assert.equal((await get(`/api/leaves/${lv.id}`)).status, 'approved');
  });
  await check('驳回后同一课次可以再请假；roster 的 leave_status 是最近一条请假的状态', async () => {
    const { A, st } = ctx.lv;
    const l = at(A.lessons, day(3));
    const first = await post('/api/leaves', { student_id: st.id, lesson_id: l.id, reason: '第一次' });
    const r = await act(`/api/leaves/${first.id}/reject`);
    assert.equal(r.status, 'rejected'); assert.equal(r.review_note, '');
    assert.equal((await get(`/api/lessons/${l.id}`)).roster.find((x) => x.student_id === st.id).leave_status, 'rejected');
    ok(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: l.id, reason: '第二次' }), 201);
    assert.equal((await get(`/api/lessons/${l.id}`)).roster.find((x) => x.student_id === st.id).leave_status, 'pending');
  });
  await check('批准上限：这个学员在这个班已批准的请假（含这次）不能超过 ceil(lesson_count × 0.2)（6 节课是 2 次），超过 409；取消一条已批准的就能再批', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 6 }); // ceil(6 × 0.2) = ceil(1.2) = 2
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id);
    const lv = [];
    for (const n of [2, 3, 4]) lv.push(await post('/api/leaves', { student_id: st.id, lesson_id: at(A.lessons, day(n)).id, reason: '请假' }));
    await act(`/api/leaves/${lv[0].id}/approve`);
    await act(`/api/leaves/${lv[1].id}/approve`);
    fail(await req('POST', `/api/leaves/${lv[2].id}/approve`, {}), 409);
    assert.equal((await get(`/api/leaves/${lv[2].id}`)).status, 'pending');
    assert.equal((await act(`/api/leaves/${lv[0].id}/cancel`)).status, 'cancelled');
    assert.equal((await act(`/api/leaves/${lv[2].id}/approve`)).status, 'approved');
  });
  await check('取消请假：创建人可以取消 pending 或 approved 的 → cancelled；别人取消 403；已取消的再取消 409', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 3 });
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id);
    const a1 = await fx.user('academic'); const a2 = await fx.user('academic');
    const lv = await post('/api/leaves', { student_id: st.id, lesson_id: at(A.lessons, day(2)).id, reason: '请假' }, a1.token);
    fail(await req('POST', `/api/leaves/${lv.id}/cancel`, {}, { as: a2.token }), 403);
    assert.equal((await act(`/api/leaves/${lv.id}/cancel`, {}, a1.token)).status, 'cancelled');
    fail(await req('POST', `/api/leaves/${lv.id}/cancel`, {}, { as: a1.token }), 409);
    const lv2 = await post('/api/leaves', { student_id: st.id, lesson_id: at(A.lessons, day(3)).id, reason: '请假' }, a1.token);
    await act(`/api/leaves/${lv2.id}/approve`);
    assert.equal((await act(`/api/leaves/${lv2.id}/cancel`, {}, a1.token)).status, 'cancelled');
  });
  await check('家长：能给自己的孩子请假（created_by 是家长）并取消；给别人的孩子请假 403；列表只有自己孩子的；不能审批 403', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 3 });
    const mine = await buyer(s, 10); const theirs = await buyer(s, 10);
    await fx.enroll(A.cls.id, mine.id); await fx.enroll(A.cls.id, theirs.id);
    const p = await fx.parentOf([mine.id]);
    const l = at(A.lessons, day(2)).id;
    const lv = await post('/api/leaves', { student_id: mine.id, lesson_id: l, reason: '感冒' }, p.token);
    assert.equal(lv.created_by, p.user.id);
    fail(await req('POST', '/api/leaves', { student_id: theirs.id, lesson_id: l, reason: '感冒' }, { as: p.token }), 403);
    const other = await post('/api/leaves', { student_id: theirs.id, lesson_id: l, reason: '感冒' });
    const items = await list('/api/leaves?page_size=100', p.token);
    assert.ok(items.some((x) => x.id === lv.id)); assert.ok(!items.some((x) => x.id === other.id));
    assert.ok(items.every((x) => x.student_id === mine.id));
    fail(await req('POST', `/api/leaves/${lv.id}/approve`, {}, { as: p.token }), 403);
    assert.equal((await act(`/api/leaves/${lv.id}/cancel`, {}, p.token)).status, 'cancelled');
  });
  await check('请假列表：student_id、status、class_id、from/to（课次日期）筛选，按 id 降序', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 4 });
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id);
    const ids = [];
    for (const n of [2, 3, 4]) ids.push((await post('/api/leaves', { student_id: st.id, lesson_id: at(A.lessons, day(n)).id, reason: '请假' })).id);
    await act(`/api/leaves/${ids[1]}/reject`);
    assert.deepEqual(pluck(await list(`/api/leaves?student_id=${st.id}`), 'id'), [ids[2], ids[1], ids[0]]);
    assert.deepEqual(pluck(await list(`/api/leaves?student_id=${st.id}&status=pending`), 'id'), [ids[2], ids[0]]);
    assert.deepEqual(pluck(await list(`/api/leaves?class_id=${A.cls.id}`), 'id'), [ids[2], ids[1], ids[0]]);
    assert.deepEqual(pluck(await list(`/api/leaves?student_id=${st.id}&from=${day(3)}&to=${day(4)}`), 'id'), [ids[2], ids[1]]);
    fail(await req('GET', `/api/leaves?from=${day(4)}&to=${day(3)}`), 400);
  });
  await check('权限：teacher 只看到自己课次的请假、不能创建 403；finance 查看请假 403；sales 不能审批 403', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(2), lessonCount: 2 });
    const st = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id);
    const lv = await post('/api/leaves', { student_id: st.id, lesson_id: A.lessons[0].id, reason: '请假' });
    const seen = await list('/api/leaves?page_size=100', s.teacherToken);
    assert.ok(seen.some((x) => x.id === lv.id)); assert.ok(seen.every((x) => x.class_id === A.cls.id));
    const other = await otherTeacher(s);
    assert.ok(!(await list('/api/leaves?page_size=100', other.token)).some((x) => x.id === lv.id));
    fail(await req('POST', '/api/leaves', { student_id: st.id, lesson_id: A.lessons[1].id, reason: '请假' }, { as: s.teacherToken }), 403);
    const fin = await fx.user('finance');
    fail(await req('GET', '/api/leaves', undefined, { as: fin.token }), 403);
    const sales = await fx.user('sales');
    fail(await req('POST', `/api/leaves/${lv.id}/approve`, {}, { as: sales.token }), 403);
  });

  group('三期·补课');
  await check('创建补课：201 {id, student_id, from_lesson_id, to_lesson_id, status=scheduled, created_at}；学员成为 to_lesson 的应到学员（source=makeup），也在 GET /api/lessons?student_id 里', async () => {
    const s = await fx.school();
    const mk = async (startTime) => { const t = await otherTeacher(s, { withUser: false }); const r = await fx.room(s.campus.id); return { teacherId: t.teacher.id, roomId: r.id, startTime }; };
    const A = await pub(s, { startDate: day(-2), lessonCount: 5, startTime: '08:40' }); // day(-2) … day(2)
    const B = await pub(s, { ...(await mk('13:40')), startDate: day(2), lessonCount: 4 }); // day(2) … day(5)
    const st = await buyer(s, 10); const st2 = await buyer(s, 10);
    await fx.enroll(A.cls.id, st.id, day(-2)); await fx.enroll(A.cls.id, st2.id, day(-2));
    await fx.attend(at(A.lessons, day(-2)).id);
    await fx.attend(at(A.lessons, day(-1)).id, { [st.id]: 'leave', [st2.id]: 'leave' });
    const from = at(A.lessons, day(-1)).id;
    const to = at(B.lessons, day(2)).id;
    const m = await post('/api/makeups', { student_id: st.id, from_lesson_id: from, to_lesson_id: to });
    assert.equal(m.student_id, st.id); assert.equal(m.from_lesson_id, from); assert.equal(m.to_lesson_id, to); assert.equal(m.status, 'scheduled');
    assert.equal(typeof m.id, 'number'); assert.equal(typeof m.created_at, 'string');
    const row = (await get(`/api/lessons/${to}`)).roster.find((r) => r.student_id === st.id);
    assert.ok(row, '补课学员应在 to_lesson 的 roster 里'); assert.equal(row.source, 'makeup');
    const mine = pluck(await get(`/api/lessons?student_id=${st.id}&from=${day(2)}&to=${day(2)}`), 'id');
    assert.deepEqual(mine.sort((a, b) => a - b), [at(A.lessons, day(2)).id, to].sort((a, b) => a - b));
    ctx.mk = { s, mk, A, B, st, st2, m, from };
  });
  await check('补课校验：from_lesson 的点名不是 leave（出勤、还没点名）409；to_lesson 是同一班级或不同课程的课次 400', async () => {
    const { s, mk, A, B, st2, from } = ctx.mk;
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: at(A.lessons, day(-2)).id, to_lesson_id: at(B.lessons, day(3)).id }), 409);
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: at(A.lessons, day(1)).id, to_lesson_id: at(B.lessons, day(3)).id }), 409);
    // 同一班级：st2 本来就在 A 的 day(2) 名单里，会同时撞上"学员在那个时间有别的课"；另建班 C，学员请假后退班，只违反这一条
    const C = await pub(s, { ...(await mk('21:10')), startDate: day(-1), lessonCount: 4 }); // day(-1) … day(2)
    const st3 = await buyer(s, 5);
    await fx.enroll(C.cls.id, st3.id, day(-1));
    await fx.attend(at(C.lessons, day(-1)).id, { [st3.id]: 'leave' });
    await del(`/api/classes/${C.cls.id}/students/${st3.id}`);
    fail(await req('POST', '/api/makeups', { student_id: st3.id, from_lesson_id: at(C.lessons, day(-1)).id, to_lesson_id: at(C.lessons, day(2)).id }), 400);
    const course2 = await fx.course(s.subject.id);
    const X = await pub(s, { ...(await mk('17:00')), course: course2, startDate: day(2), lessonCount: 1 });
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: X.lessons[0].id }), 400);
    assert.equal((await list(`/api/makeups?student_id=${st2.id}`)).length, 0);
  });
  await check('to_lesson 必须是 scheduled、还没开始：已过去的课次、已取消的课次 409', async () => {
    const { s, mk, B, st2, from } = ctx.mk;
    const P = await pub(s, { ...(await mk('19:30')), startDate: day(-3), lessonCount: 2 }); // day(-3)、day(-2)
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: at(P.lessons, day(-2)).id }), 409);
    const b5 = at(B.lessons, day(5)).id;
    await act(`/api/lessons/${b5}/cancel`, { reason: '停课' });
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: b5 }), 409);
  });
  await check('to_lesson 的应到人数已达到它所在班级的 capacity → 409', async () => {
    const { s, mk, st2, from } = ctx.mk;
    const F = await pub(s, { ...(await mk('15:20')), startDate: day(2), lessonCount: 1, capacity: 1 });
    const full = await buyer(s, 2);
    await fx.enroll(F.cls.id, full.id);
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: F.lessons[0].id }), 409);
  });
  await check('学员在 to_lesson 的时间有别的课（自己班的课次）→ 409', async () => {
    const { s, mk, st2, from } = ctx.mk;
    const B2 = await pub(s, { ...(await mk('08:40')), startDate: day(2), lessonCount: 1 }); // 与学员自己班 day(2) 08:40 重叠
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: B2.lessons[0].id }), 409);
  });
  await check('同一节请假的课只能补一次 409；删除补课（204）后学员不再是 to_lesson 的应到学员，可以重新安排', async () => {
    const { B, st, m, from } = ctx.mk;
    fail(await req('POST', '/api/makeups', { student_id: st.id, from_lesson_id: from, to_lesson_id: at(B.lessons, day(3)).id }), 409);
    await del(`/api/makeups/${m.id}`);
    assert.ok(!(await rosterIds(at(B.lessons, day(2)).id)).includes(st.id));
    const m2 = await post('/api/makeups', { student_id: st.id, from_lesson_id: from, to_lesson_id: at(B.lessons, day(3)).id });
    assert.ok((await rosterIds(at(B.lessons, day(3)).id)).includes(st.id));
    ctx.mk.m2 = m2;
  });
  await check('inactive 学员不能补课 409', async () => {
    const { B, st2, from } = ctx.mk;
    await patch(`/api/students/${st2.id}`, { status: 'inactive' });
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: at(B.lessons, day(4)).id }), 409);
    await patch(`/api/students/${st2.id}`, { status: 'active' });
  });
  await check('补课列表：student_id、status 筛选；另带 student_name、from_lesson_date、from_class_name、to_lesson_date、to_lesson_start_time、to_class_name', async () => {
    const { A, B, st, m, m2 } = ctx.mk;
    const items = await list(`/api/makeups?student_id=${st.id}`);
    assert.deepEqual(pluck(items, 'id'), [m2.id]);
    assert.ok(!pluck(items, 'id').includes(m.id));
    const x = items[0];
    assert.deepEqual([x.student_name, x.from_lesson_date, x.from_class_name, x.to_lesson_date, x.to_lesson_start_time, x.to_class_name, x.status],
      [st.name, day(-1), A.cls.name, day(3), '13:40', B.cls.name, 'scheduled']);
    assert.deepEqual(pluck(await list(`/api/makeups?student_id=${st.id}&status=done`), 'id'), []);
    assert.deepEqual(pluck(await list(`/api/makeups?student_id=${st.id}&status=scheduled`), 'id'), [m2.id]);
  });
  await check('to_lesson 点名后补课变为 done、照常扣课时（consume 指向 to_lesson）；之后删除补课 409；列表按 id 降序（用今天 23:00 还没开始的课；北京时间 22:50 以后跳过）', async () => {
    if (nowHM() >= '22:50') return;
    const { s, mk, st2, from, m2 } = ctx.mk;
    const T = await pub(s, { ...(await mk('23:00')), startDate: day(0), lessonCount: 1 });
    const to = T.lessons[0].id;
    const m3 = await post('/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: to });
    const before = await remaining(st2.id, s.course.id);
    await fx.attend(to);
    assert.equal(await remaining(st2.id, s.course.id), before - 1);
    const lg = await ledger(st2.id, s.course.id);
    assert.deepEqual([lg[lg.length - 1].reason, lg[lg.length - 1].ref_id], ['consume', to]);
    assert.equal((await list(`/api/makeups?student_id=${st2.id}`))[0].status, 'done');
    fail(await req('DELETE', `/api/makeups/${m3.id}`), 409);
    const ours = pluck(await list('/api/makeups?page_size=100'), 'id').filter((id) => id === m2.id || id === m3.id);
    assert.deepEqual(ours, [m3.id, m2.id]);
  });
  await check('权限：sales 创建补课 403；teacher 查看补课 403', async () => {
    const { s, B, st2, from } = ctx.mk;
    const sales = await fx.user('sales');
    fail(await req('POST', '/api/makeups', { student_id: st2.id, from_lesson_id: from, to_lesson_id: at(B.lessons, day(4)).id }, { as: sales.token }), 403);
    fail(await req('GET', '/api/makeups', undefined, { as: s.teacherToken }), 403);
  });

  group('三期·结课与取消班级');
  await check('结课：planning 的班、还有 scheduled 课次的班 409；全部课次点完名后 → finished', async () => {
    const s = await fx.school();
    const P = await draft(s, { startDate: day(2), lessonCount: 2 });
    fail(await req('POST', `/api/classes/${P.id}/finish`, {}), 409);
    const A = await pub(s, { startDate: day(-2), lessonCount: 2, startTime: '10:20' });
    const st = await buyer(s, 5);
    await fx.enroll(A.cls.id, st.id, day(-2));
    await fx.attend(A.lessons[0].id);
    fail(await req('POST', `/api/classes/${A.cls.id}/finish`, {}), 409);
    await fx.attend(A.lessons[1].id);
    assert.equal((await act(`/api/classes/${A.cls.id}/finish`)).status, 'finished');
    ctx.fin = { s, A, st };
  });
  await check('结课后在班学员全部退班（名单为空、student_count 0），课时不变；之后分班、改名、删除、取消、再结课都是 409', async () => {
    const { s, A, st } = ctx.fin;
    assert.deepEqual(await get(`/api/classes/${A.cls.id}/students`), []);
    assert.equal((await get(`/api/classes/${A.cls.id}`)).student_count, 0);
    assert.equal(await remaining(st.id, s.course.id), 3);
    const st2 = await buyer(s, 2);
    fail(await req('POST', `/api/classes/${A.cls.id}/students`, { student_id: st2.id }), 409);
    fail(await req('PATCH', `/api/classes/${A.cls.id}`, { name: '改名' }), 409);
    fail(await req('DELETE', `/api/classes/${A.cls.id}`), 409);
    fail(await req('POST', `/api/classes/${A.cls.id}/cancel`, { reason: '取消' }), 409);
    fail(await req('POST', `/api/classes/${A.cls.id}/finish`, {}), 409);
  });
  await check('取消 planning 的班级：reason 为空 400；成功 → cancelled，记 cancel_reason；已取消的不能改、不能删 409', async () => {
    const s = await fx.school();
    const P = await draft(s, { startDate: day(2), lessonCount: 2 });
    fail(await req('POST', `/api/classes/${P.id}/cancel`, { reason: ' ' }), 400);
    const r = await act(`/api/classes/${P.id}/cancel`, { reason: ' 招生不足 ' });
    assert.equal(r.status, 'cancelled'); assert.equal(r.cancel_reason, '招生不足');
    fail(await req('PATCH', `/api/classes/${P.id}`, { name: '改名' }), 409);
    fail(await req('DELETE', `/api/classes/${P.id}`), 409);
    fail(await req('POST', `/api/classes/${P.id}/publish`, {}), 409);
  });
  await check('取消 active 且没有点过名的班级：全部 scheduled 的课次（含已过去没点名的）一并取消，cancel_reason 同班级的；学员退班，课时不变', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-1), lessonCount: 3 }); // day(-1)、day(0)、day(1)
    const st = await buyer(s, 5);
    await fx.enroll(A.cls.id, st.id, day(-1));
    const r = await act(`/api/classes/${A.cls.id}/cancel`, { reason: '老师离职' });
    assert.equal(r.status, 'cancelled'); assert.equal(r.cancel_reason, '老师离职');
    const ls = await get(`/api/lessons?class_id=${A.cls.id}`);
    assert.deepEqual(ls.map((l) => [l.status, l.cancel_reason]), [['cancelled', '老师离职'], ['cancelled', '老师离职'], ['cancelled', '老师离职']]);
    assert.deepEqual(await get(`/api/classes/${A.cls.id}/students`), []);
    assert.equal(await remaining(st.id, s.course.id), 5);
    fail(await req('POST', `/api/classes/${A.cls.id}/students`, { student_id: st.id }), 409);
  });
  await check('已有点过名课次的班级不能取消 409，班级、课次、名单都不变；sales 结课或取消 403', async () => {
    const s = await fx.school();
    const A = await pub(s, { startDate: day(-1), lessonCount: 2 });
    const st = await buyer(s, 5);
    await fx.enroll(A.cls.id, st.id, day(-1));
    await fx.attend(at(A.lessons, day(-1)).id);
    fail(await req('POST', `/api/classes/${A.cls.id}/cancel`, { reason: '取消' }), 409);
    assert.equal((await get(`/api/classes/${A.cls.id}`)).status, 'active');
    assert.equal((await get(`/api/lessons/${at(A.lessons, day(0)).id}`)).status, 'scheduled');
    assert.deepEqual(pluck(await get(`/api/classes/${A.cls.id}/students`), 'student_id'), [st.id]);
    const sales = await fx.user('sales');
    fail(await req('POST', `/api/classes/${A.cls.id}/cancel`, { reason: '取消' }, { as: sales.token }), 403);
    fail(await req('POST', `/api/classes/${A.cls.id}/finish`, {}, { as: sales.token }), 403);
  });

  group('三期·学员考勤');
  await check('GET /api/students/:id/attendance：这个学员的点名记录 {lesson_id, date, start_time, class_name, course_name, status}，按 date、start_time 升序', async () => {
    const s = await fx.school();
    const course2 = await fx.course(s.subject.id);
    const tb = await otherTeacher(s);
    const roomB = await fx.room(s.campus.id);
    const A = await pub(s, { startDate: day(-4), lessonCount: 4, startTime: '08:40' }); // day(-4) … day(-1)
    const B = await pub(s, { course: course2, teacherId: tb.teacher.id, roomId: roomB.id, startDate: day(-2), lessonCount: 2, startTime: '13:40' }); // day(-2)、day(-1)
    const st = await fx.student(s.campus.id);
    await fx.paidOrder(st.id, [{ course_id: s.course.id, lessons: 10 }, { course_id: course2.id, lessons: 10 }]);
    await fx.enroll(A.cls.id, st.id, day(-4)); await fx.enroll(B.cls.id, st.id, day(-2));
    const statusA = ['present', 'late', 'absent', 'leave'];
    for (const [i, l] of A.lessons.entries()) await fx.attend(l.id, { [st.id]: statusA[i] });
    for (const l of B.lessons) await fx.attend(l.id);
    const rows = await get(`/api/students/${st.id}/attendance`);
    const a = (n) => at(A.lessons, day(n)); const b = (n) => at(B.lessons, day(n));
    const row = (l, cls, course, status) => [l.id, l.date, l.start_time, cls.name, course.name, status];
    assert.deepEqual(rows.map((r) => [r.lesson_id, r.date, r.start_time, r.class_name, r.course_name, r.status]), [
      row(a(-4), A.cls, s.course, 'present'), row(a(-3), A.cls, s.course, 'late'), row(a(-2), A.cls, s.course, 'absent'), row(b(-2), B.cls, course2, 'present'),
      row(a(-1), A.cls, s.course, 'leave'), row(b(-1), B.cls, course2, 'present'),
    ]);
    ctx.ka = { s, course2, tb, A, B, st };
  });
  await check('学员考勤筛选：course_id、from/to（课次日期）；from 晚于 to 400', async () => {
    const { s, course2, A, B, st } = ctx.ka;
    assert.deepEqual(pluck(await get(`/api/students/${st.id}/attendance?course_id=${s.course.id}`), 'lesson_id'), pluck(A.lessons, 'id'));
    assert.deepEqual(pluck(await get(`/api/students/${st.id}/attendance?course_id=${course2.id}`), 'lesson_id'), pluck(B.lessons, 'id'));
    assert.deepEqual(pluck(await get(`/api/students/${st.id}/attendance?from=${day(-1)}&to=${day(-1)}`), 'lesson_id'), [at(A.lessons, day(-1)).id, at(B.lessons, day(-1)).id]);
    fail(await req('GET', `/api/students/${st.id}/attendance?from=${day(-1)}&to=${day(-2)}`), 400);
  });
  await check('考勤汇总：{present, late, absent, leave, rate}，rate = (present+late)/(present+late+absent) 的百分数四舍五入；分母为 0 时 rate 为 null', async () => {
    const { s, st } = ctx.ka;
    // 本课程：出勤 1、迟到 1、缺勤 1、请假 1 → 2/3 = 66.7% → 67
    assert.deepEqual(await get(`/api/students/${st.id}/attendance/summary?course_id=${s.course.id}`), { present: 1, late: 1, absent: 1, leave: 1, rate: 67 });
    // 全部：出勤 3、迟到 1、缺勤 1、请假 1 → 4/5 = 80
    assert.deepEqual(await get(`/api/students/${st.id}/attendance/summary`), { present: 3, late: 1, absent: 1, leave: 1, rate: 80 });
    assert.deepEqual(await get(`/api/students/${st.id}/attendance/summary?course_id=${s.course.id}&from=${day(-1)}&to=${day(-1)}`), { present: 0, late: 0, absent: 0, leave: 1, rate: null });
  });
  await check('teacher 只看到这个学员在自己班级里的记录与汇总；和这个学员无关的教师 403', async () => {
    const { s, tb, A, st } = ctx.ka;
    assert.deepEqual(pluck(await get(`/api/students/${st.id}/attendance`, s.teacherToken), 'lesson_id'), pluck(A.lessons, 'id'));
    assert.deepEqual(await get(`/api/students/${st.id}/attendance/summary`, tb.token), { present: 2, late: 0, absent: 0, leave: 0, rate: 100 });
    const stranger = await otherTeacher(s);
    fail(await req('GET', `/api/students/${st.id}/attendance`, undefined, { as: stranger.token }), 403);
  });
  await check('家长能看自己孩子的考勤，别人的孩子 403；sales 能读；finance 403', async () => {
    const { s, st } = ctx.ka;
    const p = await fx.parentOf([st.id]);
    assert.equal((await get(`/api/students/${st.id}/attendance`, p.token)).length, 6);
    ok(await req('GET', `/api/students/${st.id}/attendance/summary`, undefined, { as: p.token }));
    const otherKid = await fx.student(s.campus.id);
    fail(await req('GET', `/api/students/${otherKid.id}/attendance`, undefined, { as: p.token }), 403);
    const sales = await fx.user('sales');
    ok(await req('GET', `/api/students/${st.id}/attendance`, undefined, { as: sales.token }));
    const fin = await fx.user('finance');
    fail(await req('GET', `/api/students/${st.id}/attendance`, undefined, { as: fin.token }), 403);
  });
}
