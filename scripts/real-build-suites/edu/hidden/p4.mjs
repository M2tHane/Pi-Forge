// 第四期：退费、转课、学员余额、收款流水、收入确认、课酬标准与工资单（REQ-031–REQ-037），以及 REQ-026 AC6 的"工资单确认后不能更正点名"。
// 金额单位是分；fx.school() 的课程每节 10000 分。每条用例的注释里写出期望金额的算法。
// 工资单每月全局唯一：只有这个文件建工资单，用 month(day(-1)) 这个月（昨天的课都在这个月里，也在点名更正的 7 天内；
// 每月 1 号跑时它是上个月，今天的课不在工资单月份里，代课那条跳过）。
// 别的文件的教师这个月也有点过名的课，所以只断言自己的教师那一行。
import { act, assert, check, day, fail, fx, get, group, list, month, nowHM, ok, patch, pluck, post, req } from './lib.mjs';

// —— 本文件用的小工具 ——
const pkgs = (sid, cid) => get(`/api/students/${sid}/packages?course_id=${cid}`);
const account = async (sid, cid) => (await get(`/api/students/${sid}/accounts`)).find((a) => a.course_id === cid);
const wallet = (sid, as) => get(`/api/students/${sid}/wallet`, as);
const ledger = (sid, cid) => get(`/api/students/${sid}/ledger?course_id=${cid}`);
const inClass = async (classId) => pluck(await get(`/api/classes/${classId}/students`), 'student_id');
const lessonOn = (lessons, d) => { const l = lessons.find((x) => x.date === d); assert.ok(l, `没有 ${d} 的课次`); return l; };
const sum = (arr, key) => arr.reduce((s, x) => s + x[key], 0);
const line = (payroll, teacherId) => payroll.lines.find((l) => l.teacher_id === teacherId);
/** 点名更正：statusOf 里没列出的学员保持原来的状态 */
async function correct(lessonId, statusOf, as) {
  const lesson = await get(`/api/lessons/${lessonId}`);
  const records = lesson.roster.map((s) => ({ student_id: s.student_id, status: statusOf[s.student_id] ?? s.attendance }));
  return req('PUT', `/api/lessons/${lessonId}/attendance`, { records, content: '更正' }, { as });
}
/** planning 状态的班级（不发布，没有课次） */
async function planningClass(school, extra = {}) {
  return post('/api/classes', {
    name: `筹备班${Date.now() % 100000}`, course_id: school.course.id, campus_id: school.campus.id, room_id: school.room.id, teacher_id: school.teacher.id,
    term_id: null, capacity: 10, start_date: day(30), schedule: [{ weekday: 1, start_time: '06:00' }], lesson_count: 2, ...extra,
  });
}
/** 立减 1 分的优惠：让包的 paid_amount 不能被课时数整除，用来检查 floor */
let discount1 = null;
async function minusOne() {
  discount1 ??= await post('/api/discounts', { name: '四期立减1分', type: 'amount', value: 1, min_amount: 0, valid_from: null, valid_to: null });
  return discount1;
}

export async function run() {
  group('四期·退费');
  const R = {};
  await check('创建退费：pending、RF 单号、method 为 null、另带姓名；部分退 amount = floor(paid×k/lessons)', async () => {
    R.school = await fx.school();
    R.course = R.school.course;
    R.sales = await fx.user('sales');
    R.finance = await fx.user('finance');
    const d = await minusOne();
    R.s1 = await fx.student(R.school.campus.id);
    await fx.paidOrder(R.s1.id, [{ course_id: R.course.id, lessons: 10 }], { discount_id: d.id });
    // 包：lessons 10，paid 100000 − 1 = 99999。退 3 节（不等于 remaining 10）→ floor(99999 × 3 / 10) = floor(29999.7) = 29999
    const r = await post('/api/refunds', { student_id: R.s1.id, course_id: R.course.id, lessons: 3, to: 'original', reason: ' 搬家 ' }, R.sales.token);
    assert.match(r.no, /^RF\d{6}$/);
    assert.equal(r.status, 'pending'); assert.equal(r.amount, 29999); assert.equal(r.lessons, 3); assert.equal(r.to, 'original');
    assert.equal(r.method, null); assert.equal(r.reason, '搬家'); assert.equal(r.reject_reason, '');
    assert.equal(r.created_by, R.sales.user.id); assert.equal(r.student_name, R.s1.name); assert.equal(r.course_name, R.course.name);
    R.r1 = r;
    const again = await get(`/api/refunds/${r.id}`, R.finance.token);
    assert.equal(again.amount, 29999); assert.equal(again.status, 'pending');
  });
  await check('原路退回的批准：method 必填且不能是 balance（400）；批准后扣包、加 released_amount、流水 refund、记负数的收款流水', async () => {
    const u = `/api/refunds/${R.r1.id}/approve`;
    fail(await req('POST', u, {}, { as: R.finance.token }), 400);
    fail(await req('POST', u, { method: 'balance' }, { as: R.finance.token }), 400);
    fail(await req('POST', u, { method: 'bitcoin' }, { as: R.finance.token }), 400);
    const a = await act(u, { method: 'wechat' }, R.finance.token);
    assert.equal(a.status, 'approved'); assert.equal(a.amount, 29999); assert.equal(a.method, 'wechat'); assert.equal(a.reviewed_by, R.finance.user.id);
    assert.equal(typeof a.reviewed_at, 'string');
    const [p] = await pkgs(R.s1.id, R.course.id);
    assert.equal(p.remaining, 7); assert.equal(p.released_amount, 29999); assert.equal(p.recognized_amount, 0);
    // 剩余价值 99999 − 0 − 29999 = 70000
    const acc = await account(R.s1.id, R.course.id);
    assert.equal(acc.refunded, 3); assert.equal(acc.remaining, 7); assert.equal(acc.remaining_value, 70000); assert.equal(acc.purchased, 10);
    const lg = (await ledger(R.s1.id, R.course.id)).filter((e) => e.reason === 'refund');
    assert.ok(lg.length >= 1 && lg.every((e) => e.ref_type === 'refund' && e.ref_id === R.r1.id), JSON.stringify(lg));
    assert.equal(sum(lg, 'delta'), -3);
    const pays = await list(`/api/payments?student_id=${R.s1.id}&type=refund`);
    assert.equal(pays.length, 1);
    assert.equal(pays[0].amount, -29999); assert.equal(pays[0].method, 'wechat'); assert.equal(pays[0].refund_id, R.r1.id); assert.equal(pays[0].refund_no, R.r1.no);
  });
  await check('多个包：从最晚生成的包往前退，退空一个包时退它的全部剩余价值（扣掉已确认的收入），其余按 floor(paid×k/lessons)', async () => {
    R.s2 = await fx.student(R.school.campus.id);
    await fx.paidOrder(R.s2.id, [{ course_id: R.course.id, lessons: 10 }]); // 包 A：10 节，paid 100000
    R.cr = await fx.publishedClass({ course: R.course, campusId: R.school.campus.id, roomId: R.school.room.id, teacherId: R.school.teacher.id, startDate: day(-1), lessonCount: 3 });
    await fx.enroll(R.cr.cls.id, R.s2.id, day(-1));
    await fx.enroll(R.cr.cls.id, R.s1.id, day(0)); // s1 还剩 7 节，部分退费后应留在班里；join 今天，不在昨天那节的名单里
    R.crp = await planningClass(R.school);
    await fx.enroll(R.crp.id, R.s2.id);
    // 昨天那节只有 s2：A 扣 1 节，remaining 9，确认 floor(100000 / 10) = 10000
    await fx.attend(lessonOn(R.cr.lessons, day(-1)).id);
    await fx.paidOrder(R.s2.id, [{ course_id: R.course.id, lessons: 5 }], { discount_id: (await minusOne()).id }); // 包 B：5 节，paid 49999
    // 退 7 节：B 退 5 节 = remaining → 全部剩余价值 49999；A 退 2 节 ≠ remaining 9 → floor(100000 × 2 / 10) = 20000；合计 69999
    const r = await post('/api/refunds', { student_id: R.s2.id, course_id: R.course.id, lessons: 7, to: 'balance', reason: '试算' }, R.sales.token);
    assert.equal(r.amount, 69999);
    R.r2 = r;
    const c = await act(`/api/refunds/${r.id}/cancel`, {}, R.sales.token);
    assert.equal(c.status, 'cancelled');
  });
  await check('退到余额：批准时不用 method；两个包都退空（A 退剩余价值 100000−10000=90000，B 退 49999，合计 139999），加到学员余额，不记收款流水', async () => {
    const r = await post('/api/refunds', { student_id: R.s2.id, course_id: R.course.id, lessons: 14, to: 'balance', reason: '不学了' }, R.sales.token);
    assert.equal(r.amount, 139999);
    R.r3 = r;
    const a = await act(`/api/refunds/${r.id}/approve`, {}, R.finance.token);
    assert.equal(a.status, 'approved'); assert.equal(a.amount, 139999); assert.equal(a.method, null, '退到余额的批准后 method 仍是 null');
    const ps = await pkgs(R.s2.id, R.course.id);
    assert.deepEqual(ps.map((p) => [p.lessons, p.remaining, p.recognized_amount, p.released_amount]), [[10, 0, 10000, 90000], [5, 0, 0, 49999]]);
    const w = await wallet(R.s2.id);
    assert.equal(w.balance, 139999);
    assert.deepEqual(w.entries.map((e) => [e.delta, e.reason, e.ref_type, e.ref_id]), [[139999, 'refund', 'refund', r.id]]);
    assert.deepEqual(await list(`/api/payments?student_id=${R.s2.id}&type=refund`), []);
  });
  await check('退费批准后这门课程余额为 0 的学员从 planning、active 的班级退班；还有余额的学员留在班里', async () => {
    const active = await inClass(R.cr.cls.id);
    assert.ok(!active.includes(R.s2.id), `s2 应已退出开课班 ${active}`);
    assert.ok(active.includes(R.s1.id), 's1 还有 7 节，应留在班里');
    assert.ok(!(await inClass(R.crp.id)).includes(R.s2.id), 's2 应已退出筹备班');
  });
  await check('批准时按当时的课时包重新计算金额：创建后又买了新包，就从新包退（30000 → 29999）', async () => {
    R.s3 = await fx.student(R.school.campus.id);
    await fx.paidOrder(R.s3.id, [{ course_id: R.course.id, lessons: 10 }]); // 包 A：10 节 100000
    // 创建时：A 退 3 节 → floor(100000 × 3 / 10) = 30000
    const r = await post('/api/refunds', { student_id: R.s3.id, course_id: R.course.id, lessons: 3, to: 'original', reason: '重算' }, R.sales.token);
    assert.equal(r.amount, 30000);
    await fx.paidOrder(R.s3.id, [{ course_id: R.course.id, lessons: 3 }], { discount_id: (await minusOne()).id }); // 包 B：3 节 29999
    // 批准时最晚的包是 B：退 3 节 = remaining → 全部剩余价值 29999；A 不动
    const a = await act(`/api/refunds/${r.id}/approve`, { method: 'cash' }, R.finance.token);
    assert.equal(a.amount, 29999);
    const ps = await pkgs(R.s3.id, R.course.id);
    assert.deepEqual(ps.map((p) => [p.remaining, p.released_amount]), [[10, 0], [0, 29999]]);
  });
  await check('批准时课时余额已不足 lessons → 409，退费单仍是 pending、课时包不变', async () => {
    R.s4 = await fx.student(R.school.campus.id);
    await fx.paidOrder(R.s4.id, [{ course_id: R.course.id, lessons: 2 }]); // 2 节 20000
    const c = await fx.publishedClass({ course: R.course, campusId: R.school.campus.id, roomId: R.school.room.id, teacherId: R.school.teacher.id, startDate: day(-2), lessonCount: 2 });
    await fx.enroll(c.cls.id, R.s4.id, day(-2));
    const r = await post('/api/refunds', { student_id: R.s4.id, course_id: R.course.id, lessons: 2, to: 'original', reason: '余额不足' }, R.sales.token);
    assert.equal(r.amount, 20000); // 退空包 → 全部剩余价值 20000
    await fx.attend(lessonOn(c.lessons, day(-2)).id); // 扣 1 节，剩 1 节，确认 floor(20000/2) = 10000
    fail(await req('POST', `/api/refunds/${r.id}/approve`, { method: 'cash' }, { as: R.finance.token }), 409);
    assert.equal((await get(`/api/refunds/${r.id}`)).status, 'pending');
    const [p] = await pkgs(R.s4.id, R.course.id);
    assert.equal(p.remaining, 1); assert.equal(p.released_amount, 0); assert.equal(p.recognized_amount, 10000);
    R.r4 = r;
  });
  await check('驳回：reason 必填 400；→ rejected 并记 reject_reason；不是 pending 的退费单不能再批准、驳回、取消 409', async () => {
    const u = `/api/refunds/${R.r4.id}`;
    fail(await req('POST', `${u}/reject`, {}, { as: R.finance.token }), 400);
    fail(await req('POST', `${u}/reject`, { reason: '  ' }, { as: R.finance.token }), 400);
    const r = await act(`${u}/reject`, { reason: '课时已用' }, R.finance.token);
    assert.equal(r.status, 'rejected'); assert.equal(r.reject_reason, '课时已用'); assert.equal(r.reviewed_by, R.finance.user.id);
    fail(await req('POST', `${u}/reject`, { reason: '再驳' }, { as: R.finance.token }), 409);
    fail(await req('POST', `${u}/approve`, { method: 'cash' }, { as: R.finance.token }), 409);
    fail(await req('POST', `${u}/cancel`, {}, { as: R.sales.token }), 409);
    fail(await req('POST', `/api/refunds/${R.r1.id}/approve`, { method: 'cash' }, { as: R.finance.token }), 409);
  });
  await check('创建校验：lessons 不到 1、to 不对、reason 为空 400；超过课时余额 409；同一学员同一课程第二张 pending 409；admin 能取消别人建的', async () => {
    const s = await fx.student(R.school.campus.id);
    await fx.paidOrder(s.id, [{ course_id: R.course.id, lessons: 2 }]);
    const base = { student_id: s.id, course_id: R.course.id, lessons: 1, to: 'original', reason: '校验' };
    fail(await req('POST', '/api/refunds', { ...base, lessons: 0 }, { as: R.sales.token }), 400);
    fail(await req('POST', '/api/refunds', { ...base, to: 'cash' }, { as: R.sales.token }), 400);
    fail(await req('POST', '/api/refunds', { ...base, reason: '   ' }, { as: R.sales.token }), 400);
    fail(await req('POST', '/api/refunds', { ...base, lessons: 3 }, { as: R.sales.token }), 409);
    const r = await post('/api/refunds', base, R.sales.token);
    assert.ok(Number(r.no.slice(2)) > Number(R.r3.no.slice(2)), `单号应递增：${R.r3.no} → ${r.no}`);
    fail(await req('POST', '/api/refunds', { ...base, to: 'balance' }, { as: R.sales.token }), 409);
    assert.equal((await act(`/api/refunds/${r.id}/cancel`)).status, 'cancelled');
    ok(await req('POST', '/api/refunds', base, { as: R.sales.token }), 201); // 取消后可以再建
  });
  await check('权限：finance 不能创建、sales 不能批准、别人不能取消、academic 与 teacher 不能看 403；finance、sales 能看列表', async () => {
    const body = { student_id: R.s1.id, course_id: R.course.id, lessons: 1, to: 'original', reason: '权限' };
    fail(await req('POST', '/api/refunds', body, { as: R.finance.token }), 403);
    const r = await post('/api/refunds', body, R.sales.token);
    fail(await req('POST', `/api/refunds/${r.id}/approve`, { method: 'cash' }, { as: R.sales.token }), 403);
    fail(await req('POST', `/api/refunds/${r.id}/reject`, { reason: 'x' }, { as: R.sales.token }), 403);
    const otherSales = await fx.user('sales');
    fail(await req('POST', `/api/refunds/${r.id}/cancel`, {}, { as: otherSales.token }), 403); // 只有创建人或 admin 能取消
    fail(await req('POST', `/api/refunds/${r.id}/cancel`, {}, { as: R.finance.token }), 403);
    assert.equal((await get(`/api/refunds/${r.id}`)).status, 'pending');
    const a = await fx.user('academic');
    fail(await req('GET', '/api/refunds', undefined, { as: a.token }), 403);
    fail(await req('GET', '/api/refunds', undefined, { as: R.school.teacherToken }), 403);
    assert.ok((await list(`/api/refunds?student_id=${R.s1.id}`, R.finance.token)).some((x) => x.id === r.id));
    ok(await req('GET', `/api/refunds/${r.id}`, undefined, { as: R.sales.token }));
    await act(`/api/refunds/${r.id}/cancel`, {}, R.sales.token);
  });
  await check('退费列表：student_id、status 筛选，按 id 降序', async () => {
    const all = await list(`/api/refunds?student_id=${R.s2.id}`);
    assert.deepEqual(pluck(all, 'id'), [R.r3.id, R.r2.id]);
    assert.deepEqual(pluck(all, 'status'), ['approved', 'cancelled']);
    assert.deepEqual(pluck(await list(`/api/refunds?student_id=${R.s2.id}&status=cancelled`), 'id'), [R.r2.id]);
    assert.ok((await list('/api/refunds?status=rejected&page_size=100')).every((x) => x.status === 'rejected'));
  });

  group('四期·转课');
  const T = {};
  await check('转课金额：value 按退费算法 floor(100000×3/10)=30000；to_lessons=floor(30000/7000)=4；零头 30000−28000=2000 进余额；CT 单号与名称字段', async () => {
    T.school = await fx.school();
    T.a = T.school.course; // 每节 10000
    T.b = await fx.course(T.school.subject.id, { price_per_lesson: 7000 });
    T.sales = await fx.user('sales');
    T.s = await fx.student(T.school.campus.id);
    await fx.paidOrder(T.s.id, [{ course_id: T.a.id, lessons: 10 }]); // 10 节 100000
    T.cls = await fx.publishedClass({ course: T.a, campusId: T.school.campus.id, roomId: T.school.room.id, teacherId: T.school.teacher.id, startDate: day(2), lessonCount: 2 });
    await fx.enroll(T.cls.cls.id, T.s.id);
    const ct = await post('/api/course-transfers', { student_id: T.s.id, from_course_id: T.a.id, to_course_id: T.b.id, lessons: 3 }, T.sales.token);
    assert.match(ct.no, /^CT\d{6}$/);
    assert.equal(ct.lessons, 3); assert.equal(ct.value, 30000); assert.equal(ct.to_lessons, 4); assert.equal(ct.to_balance, 2000);
    assert.equal(ct.student_id, T.s.id); assert.equal(ct.from_course_id, T.a.id); assert.equal(ct.to_course_id, T.b.id);
    assert.equal(ct.created_by, T.sales.user.id); assert.equal(ct.student_name, T.s.name);
    assert.equal(ct.from_course_name, T.a.name); assert.equal(ct.to_course_name, T.b.name); assert.equal(ct.created_by_name, T.sales.user.name);
    T.ct1 = ct;
  });
  await check('转出扣包加 released_amount（流水 transfer_out）；转入生成新包（order_id 为 null、paid=4×7000=28000，流水 transfer_in）；课时账户同步', async () => {
    const [pa] = await pkgs(T.s.id, T.a.id);
    assert.equal(pa.remaining, 7); assert.equal(pa.released_amount, 30000);
    const pb = await pkgs(T.s.id, T.b.id);
    assert.equal(pb.length, 1);
    assert.equal(pb[0].course_transfer_id, T.ct1.id); assert.equal(pb[0].order_id, null); assert.equal(pb[0].order_item_id, null);
    assert.deepEqual([pb[0].lessons, pb[0].remaining, pb[0].paid_amount, pb[0].recognized_amount, pb[0].released_amount], [4, 4, 28000, 0, 0]);
    const out = (await ledger(T.s.id, T.a.id)).filter((e) => e.reason === 'transfer_out');
    assert.equal(sum(out, 'delta'), -3); assert.ok(out.every((e) => e.ref_type === 'course_transfer' && e.ref_id === T.ct1.id));
    const inn = (await ledger(T.s.id, T.b.id)).filter((e) => e.reason === 'transfer_in');
    assert.deepEqual(inn.map((e) => [e.delta, e.ref_type, e.ref_id, e.package_id]), [[4, 'course_transfer', T.ct1.id, pb[0].id]]);
    const aa = await account(T.s.id, T.a.id);
    assert.deepEqual([aa.purchased, aa.transferred_out, aa.remaining, aa.remaining_value], [10, 3, 7, 70000]); // 100000 − 30000
    const ab = await account(T.s.id, T.b.id);
    assert.deepEqual([ab.purchased, ab.transferred_in, ab.remaining, ab.remaining_value], [0, 4, 4, 28000]);
  });
  await check('转课零头记到学员余额：reason transfer、ref_type course_transfer', async () => {
    const w = await wallet(T.s.id);
    assert.equal(w.balance, 2000);
    assert.deepEqual(w.entries.map((e) => [e.delta, e.reason, e.ref_type, e.ref_id]), [[2000, 'transfer', 'course_transfer', T.ct1.id]]);
  });
  await check('to_lessons 为 0 → 409，转出、转入、余额都不生效（10000 < 单价 50000）', async () => {
    const c = await fx.course(T.school.subject.id, { price_per_lesson: 50000 });
    // 转 1 节：floor(100000 × 1 / 10) = 10000；floor(10000 / 50000) = 0
    fail(await req('POST', '/api/course-transfers', { student_id: T.s.id, from_course_id: T.a.id, to_course_id: c.id, lessons: 1 }), 409);
    const [pa] = await pkgs(T.s.id, T.a.id);
    assert.equal(pa.remaining, 7); assert.equal(pa.released_amount, 30000);
    assert.deepEqual(await pkgs(T.s.id, c.id), []);
    assert.equal((await wallet(T.s.id)).balance, 2000);
    assert.deepEqual(pluck(await list(`/api/course-transfers?student_id=${T.s.id}`), 'id'), [T.ct1.id]);
    assert.ok(!(await ledger(T.s.id, T.a.id)).some((e) => e.reason === 'transfer_out' && e.ref_id !== T.ct1.id));
  });
  await check('转课 400：两门课程相同、to 课程已停用、to 课程单价为 0', async () => {
    const off = await fx.course(T.school.subject.id, { price_per_lesson: 5000 });
    await patch(`/api/courses/${off.id}`, { active: false });
    const free = await fx.course(T.school.subject.id, { price_per_lesson: 0 });
    const base = { student_id: T.s.id, from_course_id: T.a.id, lessons: 1 };
    fail(await req('POST', '/api/course-transfers', { ...base, to_course_id: T.a.id }), 400);
    fail(await req('POST', '/api/course-transfers', { ...base, to_course_id: off.id }), 400);
    fail(await req('POST', '/api/course-transfers', { ...base, to_course_id: free.id }), 400);
    assert.equal((await pkgs(T.s.id, T.a.id))[0].remaining, 7);
  });
  await check('转课：lessons 超过 from 课程余额 409、为 0 400；from 课程有 pending 的退费单 409', async () => {
    const base = { student_id: T.s.id, from_course_id: T.a.id, to_course_id: T.b.id };
    fail(await req('POST', '/api/course-transfers', { ...base, lessons: 8 }), 409);
    fail(await req('POST', '/api/course-transfers', { ...base, lessons: 0 }), 400);
    const r = await post('/api/refunds', { student_id: T.s.id, course_id: T.a.id, lessons: 1, to: 'original', reason: '挡住转课' });
    fail(await req('POST', '/api/course-transfers', { ...base, lessons: 1 }), 409);
    await act(`/api/refunds/${r.id}/cancel`);
    assert.equal((await pkgs(T.s.id, T.a.id))[0].remaining, 7);
  });
  await check('转出全部剩余：value 是包的全部剩余价值 100000−30000=70000，to_lessons=10、零头 0；from 课程余额为 0 后从班级退班', async () => {
    const ct = await post('/api/course-transfers', { student_id: T.s.id, from_course_id: T.a.id, to_course_id: T.b.id, lessons: 7 }, T.sales.token);
    assert.deepEqual([ct.value, ct.to_lessons, ct.to_balance], [70000, 10, 0]);
    T.ct2 = ct;
    const [pa] = await pkgs(T.s.id, T.a.id);
    assert.equal(pa.remaining, 0); assert.equal(pa.released_amount, 100000);
    assert.equal((await account(T.s.id, T.b.id)).remaining, 14);
    assert.equal((await wallet(T.s.id)).balance, 2000);
    assert.ok(!(await inClass(T.cls.cls.id)).includes(T.s.id), '余额为 0 后应退班');
  });
  await check('转课权限：academic、finance 能看不能建 403，teacher 不能看 403；列表按 student_id 筛选、id 降序', async () => {
    const body = { student_id: T.s.id, from_course_id: T.b.id, to_course_id: T.a.id, lessons: 1 };
    const a = await fx.user('academic');
    const f = await fx.user('finance');
    fail(await req('POST', '/api/course-transfers', body, { as: a.token }), 403);
    fail(await req('POST', '/api/course-transfers', body, { as: f.token }), 403);
    fail(await req('GET', '/api/course-transfers', undefined, { as: T.school.teacherToken }), 403);
    assert.deepEqual(pluck(await list(`/api/course-transfers?student_id=${T.s.id}`, a.token), 'id'), [T.ct2.id, T.ct1.id]);
    ok(await req('GET', `/api/course-transfers?student_id=${T.s.id}`, undefined, { as: f.token }));
  });

  group('四期·学员余额');
  const W = {};
  await check('还没有记录时余额为 0、entries 为空；退到余额后加上（floor(100000×2/10)=20000）', async () => {
    W.school = await fx.school();
    W.finance = await fx.user('finance');
    W.s = await fx.student(W.school.campus.id);
    await fx.paidOrder(W.s.id, [{ course_id: W.school.course.id, lessons: 10 }]);
    const w0 = await wallet(W.s.id);
    assert.equal(w0.balance, 0); assert.deepEqual(w0.entries, []);
    const r = await post('/api/refunds', { student_id: W.s.id, course_id: W.school.course.id, lessons: 2, to: 'balance', reason: '充值余额' });
    assert.equal(r.amount, 20000);
    await act(`/api/refunds/${r.id}/approve`, {}, W.finance.token);
    assert.equal((await wallet(W.s.id)).balance, 20000);
  });
  await check('用余额支付订单：余额减少，记 payment 条目（负数，ref_type order），不记收款流水', async () => {
    const order = await post('/api/orders', { student_id: W.s.id, items: [{ course_id: W.school.course.id, lessons: 1 }], discount_id: null, note: '' });
    const paid = await act(`/api/orders/${order.id}/pay`, { method: 'balance', amount: 10000 });
    assert.equal(paid.status, 'paid'); assert.equal(paid.payment_method, 'balance');
    const w = await wallet(W.s.id);
    assert.equal(w.balance, 10000); // 20000 − 10000
    const last = w.entries.at(-1);
    assert.deepEqual([last.delta, last.reason, last.ref_type, last.ref_id], [-10000, 'payment', 'order', order.id]);
    assert.ok(!(await list(`/api/payments?student_id=${W.s.id}`)).some((p) => p.order_id === order.id), '余额支付不记收款流水');
    assert.ok((await pkgs(W.s.id, W.school.course.id)).some((p) => p.order_id === order.id && p.lessons === 1), '余额支付也生成课时包');
  });
  await check('余额不够支付 → 409，订单仍是 pending、余额不变', async () => {
    const order = await post('/api/orders', { student_id: W.s.id, items: [{ course_id: W.school.course.id, lessons: 2 }], discount_id: null, note: '' });
    fail(await req('POST', `/api/orders/${order.id}/pay`, { method: 'balance', amount: 20000 }), 409); // 要 20000，只有 10000
    assert.equal((await get(`/api/orders/${order.id}`)).status, 'pending');
    assert.equal((await wallet(W.s.id)).balance, 10000);
  });
  await check('取现：超过余额 409、amount 不到 1 或 method 是 balance 400；成功后余额减少，记 withdraw 条目与负数的取现流水，entries 按 id 升序', async () => {
    const u = `/api/students/${W.s.id}/wallet/withdraw`;
    fail(await req('POST', u, { amount: 10001, method: 'cash' }, { as: W.finance.token }), 409);
    fail(await req('POST', u, { amount: 0, method: 'cash' }, { as: W.finance.token }), 400);
    fail(await req('POST', u, { amount: 100, method: 'balance' }, { as: W.finance.token }), 400);
    const w = await act(u, { amount: 4000, method: 'alipay' }, W.finance.token);
    assert.equal(w.balance, 6000); // 10000 − 4000
    assert.deepEqual(w.entries.map((e) => e.reason), ['refund', 'payment', 'withdraw']);
    assert.deepEqual(w.entries.map((e) => e.delta), [20000, -10000, -4000]);
    const ids = pluck(w.entries, 'id');
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
    const [py] = await list(`/api/payments?student_id=${W.s.id}&type=withdraw`);
    assert.equal(py.amount, -4000); assert.equal(py.method, 'alipay'); assert.equal(py.order_id, null); assert.equal(py.refund_id, null);
    assert.equal(w.entries.at(-1).ref_type, 'payment'); assert.equal(w.entries.at(-1).ref_id, py.id);
    assert.deepEqual(await wallet(W.s.id), w);
  });
  await check('余额权限：sales 能看不能取现、academic 与 teacher 不能看 403；家长能看自己孩子的、别人的 403', async () => {
    const sales = await fx.user('sales');
    assert.equal((await wallet(W.s.id, sales.token)).balance, 6000);
    fail(await req('POST', `/api/students/${W.s.id}/wallet/withdraw`, { amount: 1, method: 'cash' }, { as: sales.token }), 403);
    const a = await fx.user('academic');
    fail(await req('GET', `/api/students/${W.s.id}/wallet`, undefined, { as: a.token }), 403);
    fail(await req('GET', `/api/students/${W.s.id}/wallet`, undefined, { as: W.school.teacherToken }), 403);
    const other = await fx.student(W.school.campus.id);
    const p = await fx.parentOf([W.s.id]);
    assert.equal((await wallet(W.s.id, p.token)).balance, 6000);
    fail(await req('GET', `/api/students/${other.id}/wallet`, undefined, { as: p.token }), 403);
    assert.equal((await wallet(W.s.id)).balance, 6000);
  });

  group('四期·收款流水');
  const P = {};
  await check('订单支付记 payment 流水：PY 单号、正数金额、order_no、student_no、created_by_name，refund 相关为 null', async () => {
    P.before = await get(`/api/payments/summary?from=${day(0)}&to=${day(0)}`);
    P.school = await fx.school();
    P.s = await fx.student(P.school.campus.id);
    P.order = await fx.paidOrder(P.s.id, [{ course_id: P.school.course.id, lessons: 3 }], { method: 'transfer' }); // 30000
    const [py] = await list(`/api/payments?student_id=${P.s.id}`);
    assert.match(py.no, /^PY\d{6}$/);
    assert.equal(py.type, 'payment'); assert.equal(py.amount, 30000); assert.equal(py.method, 'transfer');
    assert.equal(py.student_id, P.s.id); assert.equal(py.student_name, P.s.name); assert.equal(py.student_no, P.s.no);
    assert.equal(py.order_id, P.order.id); assert.equal(py.order_no, P.order.no);
    assert.equal(py.refund_id, null); assert.equal(py.refund_no, null);
    assert.equal(py.created_by_name, '管理员'); assert.equal(typeof py.created_at, 'string');
    P.py1 = py;
  });
  await check('原路退费记 refund 流水：金额为负（floor(30000×1/3)=10000 → −10000），带 refund_no，order 相关为 null', async () => {
    const r = await post('/api/refunds', { student_id: P.s.id, course_id: P.school.course.id, lessons: 1, to: 'original', reason: '流水' });
    assert.equal(r.amount, 10000);
    await act(`/api/refunds/${r.id}/approve`, { method: 'card' });
    const rows = await list(`/api/payments?student_id=${P.s.id}&type=refund`);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].amount, rows[0].method, rows[0].refund_id, rows[0].refund_no, rows[0].order_id, rows[0].order_no], [-10000, 'card', r.id, r.no, null, null]);
    assert.ok(Number(rows[0].no.slice(2)) > Number(P.py1.no.slice(2)));
    P.py2 = rows[0];
  });
  await check('流水列表：按 id 降序；type、method、student_id、from/to（日期）筛选；from 晚于 to 400', async () => {
    assert.deepEqual(pluck(await list(`/api/payments?student_id=${P.s.id}`), 'id'), [P.py2.id, P.py1.id]);
    assert.deepEqual(pluck(await list(`/api/payments?student_id=${P.s.id}&type=payment`), 'id'), [P.py1.id]);
    assert.deepEqual(pluck(await list(`/api/payments?student_id=${P.s.id}&method=card`), 'id'), [P.py2.id]);
    assert.deepEqual(pluck(await list(`/api/payments?student_id=${P.s.id}&from=${day(0)}&to=${day(0)}`), 'id'), [P.py2.id, P.py1.id]);
    assert.deepEqual(await list(`/api/payments?student_id=${P.s.id}&from=${day(1)}&to=${day(1)}`), []);
    assert.ok((await list('/api/payments?type=withdraw&page_size=100')).every((p) => p.type === 'withdraw' && p.amount < 0));
    fail(await req('GET', `/api/payments?from=${day(1)}&to=${day(0)}`), 400);
    fail(await req('GET', '/api/payments?type=gift'), 400);
  });
  await check('汇总：income 正数之和、outgo 负数之和的绝对值、net = income − outgo；by_method 按方式字母顺序且与总数一致（本条增加 transfer +30000、card −10000）', async () => {
    const after = await get(`/api/payments/summary?from=${day(0)}&to=${day(0)}`);
    assert.equal(after.income - P.before.income, 30000);
    assert.equal(after.outgo - P.before.outgo, 10000);
    assert.equal(after.net, after.income - after.outgo);
    const m = (s, k) => s.by_method.find((x) => x.method === k) ?? { income: 0, outgo: 0, net: 0 };
    assert.equal(m(after, 'transfer').income - m(P.before, 'transfer').income, 30000);
    assert.equal(m(after, 'card').outgo - m(P.before, 'card').outgo, 10000);
    const methods = pluck(after.by_method, 'method');
    assert.deepEqual(methods, [...methods].sort());
    assert.equal(sum(after.by_method, 'income'), after.income); assert.equal(sum(after.by_method, 'outgo'), after.outgo);
    assert.ok(after.by_method.every((x) => x.net === x.income - x.outgo));
  });
  await check('汇总必须给 from、to（400）；流水不能修改删除（404）；sales、academic、teacher 不能看流水与汇总 403，finance 能看', async () => {
    fail(await req('GET', '/api/payments/summary'), 400);
    fail(await req('GET', `/api/payments/summary?from=${day(0)}`), 400);
    fail(await req('DELETE', `/api/payments/${P.py1.id}`), 404);
    fail(await req('PATCH', `/api/payments/${P.py1.id}`, { amount: 1 }), 404);
    for (const role of ['sales', 'academic']) {
      const u = await fx.user(role);
      fail(await req('GET', '/api/payments', undefined, { as: u.token }), 403);
      fail(await req('GET', `/api/payments/summary?from=${day(0)}&to=${day(0)}`, undefined, { as: u.token }), 403);
    }
    fail(await req('GET', '/api/payments', undefined, { as: P.school.teacherToken }), 403);
    const f = await fx.user('finance');
    ok(await req('GET', `/api/payments/summary?from=${day(0)}&to=${day(0)}`, undefined, { as: f.token }));
    ok(await req('GET', `/api/payments?student_id=${P.s.id}`, undefined, { as: f.token }));
  });

  group('四期·收入确认');
  const V = {};
  const rev = (q, as) => get(`/api/reports/revenue?${q}`, as);
  await check('按班级的校区汇总：absent 也确认收入、leave 不算；by_course、by_campus 按编号升序，lessons 是扣课时的人次', async () => {
    V.school = await fx.school(); // K1 每节 10000
    V.k2 = await fx.course(V.school.subject.id, { price_per_lesson: 3333 });
    V.campusY = await fx.campus();
    const d = await minusOne();
    V.s1 = await fx.student(V.school.campus.id);
    V.s2 = await fx.student(V.campusY.id); // 学员属于别的校区，但上的是 X 校区的班
    V.s3 = await fx.student(V.school.campus.id);
    await fx.paidOrder(V.s1.id, [{ course_id: V.school.course.id, lessons: 10 }], { discount_id: d.id }); // 99999，每节确认 floor(99999/10)=9999
    await fx.paidOrder(V.s2.id, [{ course_id: V.school.course.id, lessons: 2 }]); // 20000，每节 10000
    await fx.paidOrder(V.s3.id, [{ course_id: V.k2.id, lessons: 3 }]); // 9999，每节 floor(9999/3)=3333
    const opt = { campusId: V.school.campus.id, roomId: V.school.room.id, teacherId: V.school.teacher.id, startDate: day(-3) };
    const c1 = await fx.publishedClass({ ...opt, course: V.school.course, lessonCount: 3 });
    const c2 = await fx.publishedClass({ ...opt, course: V.k2, lessonCount: 1 });
    await fx.enroll(c1.cls.id, V.s1.id, day(-3));
    await fx.enroll(c1.cls.id, V.s2.id, day(-3));
    await fx.enroll(c2.cls.id, V.s3.id, day(-3));
    V.l3 = lessonOn(c1.lessons, day(-3));
    V.l2 = lessonOn(c1.lessons, day(-2));
    await fx.attend(V.l3.id, { [V.s1.id]: 'present', [V.s2.id]: 'absent' }); // s1 9999，s2 10000（剩 1 节，不是最后一节，floor(20000/2)）
    await fx.attend(V.l2.id, { [V.s1.id]: 'late', [V.s2.id]: 'leave' }); // s1 9999，s2 不扣
    await fx.attend(lessonOn(c2.lessons, day(-3)).id); // s3 3333
    // 合计 9999 + 10000 + 9999 + 3333 = 33331，人次 4；K1：3 人次 29998；K2：1 人次 3333
    const r = await rev(`from=${day(-3)}&to=${day(-1)}&campus_id=${V.school.campus.id}`);
    assert.equal(r.total, 33331); assert.equal(r.lessons, 4);
    assert.deepEqual(r.by_course.map((x) => [x.course_id, x.course_name, x.lessons, x.amount]), [[V.school.course.id, V.school.course.name, 3, 29998], [V.k2.id, V.k2.name, 1, 3333]]);
    assert.deepEqual(r.by_campus.map((x) => [x.campus_id, x.campus_name, x.lessons, x.amount]), [[V.school.campus.id, V.school.campus.name, 4, 33331]]);
  });
  await check('日期按课次日期筛选（含两端）；与点名记录的 recognized_amount 一致', async () => {
    const r = await rev(`from=${day(-2)}&to=${day(-2)}&campus_id=${V.school.campus.id}`);
    assert.equal(r.total, 9999); assert.equal(r.lessons, 1); // 只有 s1 迟到那一条
    assert.deepEqual(r.by_course.map((x) => [x.course_id, x.lessons, x.amount]), [[V.school.course.id, 1, 9999]]);
    const none = await rev(`from=${day(-6)}&to=${day(-4)}&campus_id=${V.school.campus.id}`);
    assert.deepEqual([none.total, none.lessons, none.by_course, none.by_campus], [0, 0, [], []]);
    const att = await get(`/api/lessons/${V.l3.id}/attendance`);
    assert.deepEqual(att.map((a) => [a.student_id, a.status, a.recognized_amount]), [[V.s1.id, 'present', 9999], [V.s2.id, 'absent', 10000]].sort((x, y) => x[0] - y[0]));
  });
  await check('campus_id 按班级的校区，不按学员的所属校区：用 s2 所属的校区筛选是空的', async () => {
    const r = await rev(`from=${day(-3)}&to=${day(-1)}&campus_id=${V.campusY.id}`);
    assert.deepEqual([r.total, r.lessons, r.by_course, r.by_campus], [0, 0, [], []]);
  });
  await check('收入按更正后的点名结果：迟到改请假退回 9999，请假改出勤扣最后一节确认剩余价值 20000−10000=10000（合计 33332）', async () => {
    ok(await correct(V.l2.id, { [V.s1.id]: 'leave', [V.s2.id]: 'present' }));
    // day(-3)：9999 + 10000；day(-2)：s2 10000；K2：3333 → 33332，人次 4；K1 3 人次 29999
    const r = await rev(`from=${day(-3)}&to=${day(-1)}&campus_id=${V.school.campus.id}`);
    assert.equal(r.total, 33332); assert.equal(r.lessons, 4);
    assert.deepEqual(r.by_course.map((x) => [x.course_id, x.lessons, x.amount]), [[V.school.course.id, 3, 29999], [V.k2.id, 1, 3333]]);
  });
  await check('收入确认必须给 from、to，from 晚于 to 400；sales、academic、teacher 403，finance 能看', async () => {
    fail(await req('GET', '/api/reports/revenue'), 400);
    fail(await req('GET', `/api/reports/revenue?from=${day(-1)}`), 400);
    fail(await req('GET', `/api/reports/revenue?from=${day(0)}&to=${day(-1)}`), 400);
    for (const role of ['sales', 'academic']) {
      const u = await fx.user(role);
      fail(await req('GET', `/api/reports/revenue?from=${day(-3)}&to=${day(-1)}`, undefined, { as: u.token }), 403);
    }
    fail(await req('GET', `/api/reports/revenue?from=${day(-3)}&to=${day(-1)}`, undefined, { as: V.school.teacherToken }), 403);
    const f = await fx.user('finance');
    assert.equal((await rev(`from=${day(-3)}&to=${day(-1)}&campus_id=${V.school.campus.id}`, f.token)).total, 33332);
  });

  group('四期·课酬标准');
  const K = {};
  await check('课酬标准：带 teacher_name、course_name；同一教师同一课程第二条 409；amount 越界、教师不存在 400', async () => {
    K.school = await fx.school(); // 教师 pay_per_lesson 5000
    K.kp = K.school.course;
    K.kp2 = await fx.course(K.school.subject.id);
    K.tp = K.school.teacher;
    K.finance = await fx.user('finance');
    const r = await post('/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp2.id, amount: 7001 }, K.finance.token);
    assert.deepEqual([r.teacher_id, r.course_id, r.amount, r.teacher_name, r.course_name], [K.tp.id, K.kp2.id, 7001, K.tp.name, K.kp2.name]);
    K.rate = r;
    fail(await req('POST', '/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp2.id, amount: 100 }), 409);
    fail(await req('POST', '/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp.id, amount: -1 }), 400);
    fail(await req('POST', '/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp.id, amount: 1000001 }), 400);
    fail(await req('POST', '/api/pay-rates', { teacher_id: 999999, course_id: K.kp.id, amount: 100 }), 400);
  });
  await check('PATCH 改 amount；GET 按 teacher_id 筛选（数组）；DELETE 204', async () => {
    const r = await post('/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp.id, amount: 9000 });
    assert.equal((await patch(`/api/pay-rates/${r.id}`, { amount: 9500 })).amount, 9500);
    const mine = await get(`/api/pay-rates?teacher_id=${K.tp.id}`);
    assert.ok(Array.isArray(mine));
    assert.deepEqual(mine.map((x) => [x.course_id, x.amount]).sort((a, b) => a[0] - b[0]), [[K.kp.id, 9500], [K.kp2.id, 7001]].sort((a, b) => a[0] - b[0]));
    const other = await fx.teacher(K.school.campus.id, [K.school.subject.id], { withUser: false });
    await post('/api/pay-rates', { teacher_id: other.teacher.id, course_id: K.kp.id, amount: 1 });
    assert.ok((await get(`/api/pay-rates?teacher_id=${K.tp.id}`)).every((x) => x.teacher_id === K.tp.id));
    assert.equal((await req('DELETE', `/api/pay-rates/${r.id}`)).status, 204);
    assert.deepEqual(pluck(await get(`/api/pay-rates?teacher_id=${K.tp.id}`), 'id'), [K.rate.id]);
  });
  await check('课酬标准权限：academic、sales、teacher 都是 403', async () => {
    for (const role of ['academic', 'sales']) {
      const u = await fx.user(role);
      fail(await req('GET', '/api/pay-rates', undefined, { as: u.token }), 403);
    }
    fail(await req('GET', '/api/pay-rates', undefined, { as: K.school.teacherToken }), 403);
    fail(await req('POST', '/api/pay-rates', { teacher_id: K.tp.id, course_id: K.kp.id, amount: 1 }, { as: K.school.teacherToken }), 403);
  });

  group('四期·工资单');
  const M = month(day(-1));
  const Y = {};
  await check('没有已完成课次的月份照样生成，lines 为空、total 0、draft；month 格式不对 400', async () => {
    fail(await req('POST', '/api/payrolls', { month: '2001-13' }), 400);
    fail(await req('POST', '/api/payrolls', { month: '2001-1' }), 400);
    const p = await post('/api/payrolls', { month: '2001-01' }, K.finance.token);
    assert.deepEqual([p.month, p.status, p.lines, p.total, p.confirmed_at, p.paid_at], ['2001-01', 'draft', [], 0, null, null]);
    Y.empty = p;
  });
  await check('同一个月第二张 409；draft 的工资单可以删除（204，之后 404），删除后可以重建', async () => {
    const opt = { campusId: K.school.campus.id, roomId: K.school.room.id, teacherId: K.tp.id, startDate: day(-1) };
    const sp1 = await fx.student(K.school.campus.id);
    const sp2 = await fx.student(K.school.campus.id);
    await fx.paidOrder(sp1.id, [{ course_id: K.kp.id, lessons: 10 }, { course_id: K.kp2.id, lessons: 10 }]);
    await fx.paidOrder(sp2.id, [{ course_id: K.kp2.id, lessons: 10 }]);
    // C_a：KP，没有课酬标准 → 教师的 5000；两节（昨天、今天），只点昨天那节
    Y.ca = await fx.publishedClass({ ...opt, course: K.kp, lessonCount: 2 });
    Y.cb = await fx.publishedClass({ ...opt, course: K.kp2, lessonCount: 1 }); // 全员缺勤 → floor(7001/2) = 3500
    Y.cc = await fx.publishedClass({ ...opt, course: K.kp2, lessonCount: 1 }); // 迟到 → 7001
    await fx.enroll(Y.ca.cls.id, sp1.id, day(-1));
    await fx.enroll(Y.cb.cls.id, sp1.id, day(-1));
    await fx.enroll(Y.cc.cls.id, sp2.id, day(-1));
    await fx.attend(lessonOn(Y.ca.lessons, day(-1)).id);
    await fx.attend(Y.cb.lessons[0].id, { [sp1.id]: 'absent' });
    await fx.attend(Y.cc.lessons[0].id, { [sp2.id]: 'late' });
    Y.sp2 = sp2;
    // 代课：今天 23:00 的课在开始前换给代课教师（每节 4000），再点名；做不到（今天不在这个月、或已过 22:50）就跳过
    Y.subOK = month(day(0)) === M && nowHM() < '22:50';
    if (Y.subOK) {
      Y.ts = await fx.teacher(K.school.campus.id, [K.school.subject.id], { pay_per_lesson: 4000 });
      const sp3 = await fx.student(K.school.campus.id);
      await fx.paidOrder(sp3.id, [{ course_id: K.kp.id, lessons: 2 }]);
      const cd = await fx.publishedClass({ ...opt, course: K.kp, startDate: day(0), lessonCount: 1, startTime: '23:00' });
      await fx.enroll(cd.cls.id, sp3.id);
      await act(`/api/lessons/${cd.lessons[0].id}/substitute`, { teacher_id: Y.ts.teacher.id });
      await fx.attend(cd.lessons[0].id);
    }
    const first = await post('/api/payrolls', { month: M }, K.finance.token);
    fail(await req('POST', '/api/payrolls', { month: M }, { as: K.finance.token }), 409);
    assert.equal((await req('DELETE', `/api/payrolls/${first.id}`, undefined, { as: K.finance.token })).status, 204);
    fail(await req('GET', `/api/payrolls/${first.id}`), 404);
    Y.p = await post('/api/payrolls', { month: M }, K.finance.token);
    assert.ok(Y.p.id > first.id);
  });
  await check('教师一行：有课酬标准用标准、否则用教师课酬，实到 0 人按一半向下取整，没点名的课次不算（5000+3500+7001=15501，3 节）', async () => {
    const l = line(Y.p, K.tp.id);
    assert.ok(l, '工资单里应有这位教师');
    assert.deepEqual([l.teacher_name, l.lessons, l.lesson_pay, l.adjustment, l.total], [K.tp.name, 3, 15501, 0, 15501]);
  });
  await check(`课酬算给点名完成时的上课教师（代课教师每节 4000）${Y.subOK ? '' : '（今天不在工资单月份或已过 22:50，本条跳过）'}`, async () => {
    assert.ok(Y.p, '前面造数据或建工资单失败');
    if (!Y.subOK) return;
    const l = line(Y.p, Y.ts.teacher.id);
    assert.ok(l, '代课教师应有一行');
    assert.deepEqual([l.lessons, l.lesson_pay, l.total], [1, 4000, 4000]);
    assert.equal(line(Y.p, K.tp.id).lessons, 3, '代课的那节不算原来的教师');
  });
  await check('工资单结构：draft、lines 按 teacher_id 升序、total 是各行之和；GET /:id 相同；GET /api/payrolls 按 month 降序', async () => {
    assert.equal(Y.p.month, M); assert.equal(Y.p.status, 'draft'); assert.equal(Y.p.confirmed_at, null); assert.equal(Y.p.paid_at, null);
    const tids = pluck(Y.p.lines, 'teacher_id');
    assert.deepEqual(tids, [...tids].sort((a, b) => a - b));
    assert.equal(Y.p.total, sum(Y.p.lines, 'total'));
    assert.ok(Y.p.lines.every((l) => l.total === l.lesson_pay + l.adjustment));
    assert.deepEqual(await get(`/api/payrolls/${Y.p.id}`, K.finance.token), Y.p);
    const months = pluck(await list('/api/payrolls?page_size=100'), 'month');
    assert.deepEqual(months, [...months].sort().reverse());
    assert.ok(months.indexOf(M) < months.indexOf('2001-01'));
  });
  await check('调整：教师不在工资单里 400；调整后 total < 0（−15502）400 且不生效；amount 越界、note 超过 100 字 400', async () => {
    const u = `/api/payrolls/${Y.p.id}/adjust`;
    const outsider = await fx.teacher(K.school.campus.id, [K.school.subject.id], { withUser: false });
    fail(await req('POST', u, { teacher_id: outsider.teacher.id, amount: 100, note: '' }), 400);
    fail(await req('POST', u, { teacher_id: K.tp.id, amount: -15502, note: '扣光' }), 400);
    fail(await req('POST', u, { teacher_id: K.tp.id, amount: 1000001, note: '' }), 400);
    fail(await req('POST', u, { teacher_id: K.tp.id, amount: 100, note: 'x'.repeat(101) }), 400);
    const l = line(await get(`/api/payrolls/${Y.p.id}`), K.tp.id);
    assert.equal(l.adjustment, 0); assert.equal(l.total, 15501);
  });
  await check('调整替换这位教师的调整额：−15501 时 total 为 0 可以；再改成 +1000 → total 16501，工资单 total 同步', async () => {
    const u = `/api/payrolls/${Y.p.id}/adjust`;
    assert.equal(line(await act(u, { teacher_id: K.tp.id, amount: -15501, note: '' }, K.finance.token), K.tp.id).total, 0);
    const p = await act(u, { teacher_id: K.tp.id, amount: 1000, note: '全勤奖' }, K.finance.token);
    const l = line(p, K.tp.id);
    assert.deepEqual([l.adjustment, l.adjustment_note, l.total], [1000, '全勤奖', 16501]);
    assert.equal(p.total, sum(p.lines, 'total'));
  });
  await check('重算：按当前课酬标准重算（7001→8001：5000+4000+8001=17001），保留调整额；新出现的教师调整额为 0', async () => {
    const tn = await fx.teacher(K.school.campus.id, [K.school.subject.id]); // 每节 5000
    const sp4 = await fx.student(K.school.campus.id);
    await fx.paidOrder(sp4.id, [{ course_id: K.kp.id, lessons: 2 }]);
    const cn = await fx.publishedClass({ course: K.kp, campusId: K.school.campus.id, roomId: K.school.room.id, teacherId: tn.teacher.id, startDate: day(-1), lessonCount: 1 });
    await fx.enroll(cn.cls.id, sp4.id, day(-1));
    await fx.attend(cn.lessons[0].id);
    await patch(`/api/pay-rates/${K.rate.id}`, { amount: 8001 });
    const p = await act(`/api/payrolls/${Y.p.id}/recalculate`, {}, K.finance.token);
    const l = line(p, K.tp.id);
    assert.deepEqual([l.lessons, l.lesson_pay, l.adjustment, l.total], [3, 17001, 1000, 18001]);
    const ln = line(p, tn.teacher.id);
    assert.ok(ln, '新出现的教师应有一行');
    assert.deepEqual([ln.lessons, ln.lesson_pay, ln.adjustment, ln.total], [1, 5000, 0, 5000]);
    assert.equal(p.total, sum(p.lines, 'total'));
    Y.p = p;
  });
  await check('草稿时可以更正这个月的点名；teacher 在工资单确认前查 /api/payrolls/mine 是 404', async () => {
    const r = await correct(Y.cc.lessons[0].id, { [Y.sp2.id]: 'present' });
    ok(r);
    fail(await req('GET', `/api/payrolls/mine?month=${M}`, undefined, { as: K.school.teacherToken }), 404);
    assert.ok(!(await get('/api/payrolls/mine', K.school.teacherToken)).some((x) => x.month === M));
  });
  await check('确认：draft → confirmed、填 confirmed_at；再确认 409', async () => {
    const p = await act(`/api/payrolls/${Y.p.id}/confirm`, {}, K.finance.token);
    assert.equal(p.status, 'confirmed'); assert.equal(typeof p.confirmed_at, 'string'); assert.equal(p.paid_at, null);
    fail(await req('POST', `/api/payrolls/${Y.p.id}/confirm`), 409);
    Y.p = p;
  });
  await check('confirmed 的工资单不能重算、调整、删除 409，内容不变', async () => {
    fail(await req('POST', `/api/payrolls/${Y.p.id}/recalculate`, {}), 409);
    fail(await req('POST', `/api/payrolls/${Y.p.id}/adjust`, { teacher_id: K.tp.id, amount: 0, note: '' }), 409);
    fail(await req('DELETE', `/api/payrolls/${Y.p.id}`), 409);
    const p = await get(`/api/payrolls/${Y.p.id}`);
    assert.equal(p.status, 'confirmed'); assert.equal(line(p, K.tp.id).total, 18001);
  });
  await check('工资单确认后，这个月课次的点名更正 → 409，点名记录不变（REQ-026 AC6）', async () => {
    const lessonId = Y.cc.lessons[0].id;
    fail(await correct(lessonId, { [Y.sp2.id]: 'absent' }), 409);
    const att = await get(`/api/lessons/${lessonId}/attendance`);
    assert.deepEqual(att.map((a) => [a.student_id, a.status]), [[Y.sp2.id, 'present']]);
  });
  await check('/api/payrolls/mine：给 month 返回自己那一行另带 status；不给返回各月的行另带 month、status', async () => {
    const t = K.school.teacherToken;
    const m = await get(`/api/payrolls/mine?month=${M}`, t);
    assert.deepEqual([m.teacher_id, m.lessons, m.lesson_pay, m.adjustment, m.total, m.status], [K.tp.id, 3, 17001, 1000, 18001, 'confirmed']);
    const all = await get('/api/payrolls/mine', t);
    assert.ok(Array.isArray(all));
    const row = all.find((x) => x.month === M);
    assert.ok(row, '应有这个月的行');
    assert.deepEqual([row.teacher_id, row.total, row.status], [K.tp.id, 18001, 'confirmed']);
    fail(await req('GET', '/api/payrolls/mine?month=2001-01', undefined, { as: t }), 404); // 2001-01 是草稿且没有这位教师
  });
  await check('发放：confirmed → paid、填 paid_at；再发放 409；draft 不能发放 409；mine 的 status 变为 paid', async () => {
    fail(await req('POST', `/api/payrolls/${Y.empty.id}/pay`), 409);
    const p = await act(`/api/payrolls/${Y.p.id}/pay`, {}, K.finance.token);
    assert.equal(p.status, 'paid'); assert.equal(typeof p.paid_at, 'string');
    fail(await req('POST', `/api/payrolls/${Y.p.id}/pay`), 409);
    fail(await req('POST', `/api/payrolls/${Y.p.id}/confirm`), 409);
    fail(await req('DELETE', `/api/payrolls/${Y.p.id}`), 409);
    assert.equal((await get(`/api/payrolls/mine?month=${M}`, K.school.teacherToken)).status, 'paid');
  });
  await check('工资单权限：teacher 只能用 /mine（列表 403），sales、academic 403；没有绑定教师档案的 teacher 查 mine 404', async () => {
    fail(await req('GET', '/api/payrolls', undefined, { as: K.school.teacherToken }), 403);
    fail(await req('GET', `/api/payrolls/${Y.p.id}`, undefined, { as: K.school.teacherToken }), 403);
    for (const role of ['sales', 'academic']) {
      const u = await fx.user(role);
      fail(await req('GET', '/api/payrolls', undefined, { as: u.token }), 403);
      fail(await req('POST', '/api/payrolls', { month: '2001-02' }, { as: u.token }), 403);
    }
    const lone = await fx.user('teacher');
    fail(await req('GET', `/api/payrolls/mine?month=${M}`, undefined, { as: lone.token }), 404);
  });
}
