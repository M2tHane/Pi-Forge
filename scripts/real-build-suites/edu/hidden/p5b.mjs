// 第五期（下）：看板、招生报表、消课出勤与余额预警、导出 CSV、操作日志（REQ-045–REQ-049）。
// 统计都在本文件新建的校区里做（campus_id 筛选），不受别的文件的数据影响。
// 不做点名更正（PUT attendance）：p4 的工资单在 month(day(-1)) 这个月，确认后更正会 409。
import { act, assert, check, day, fail, fx, get, group, list, ok, patch, pluck, post, req, rt } from './lib.mjs';

// —— 本文件自己的工具 ——
let k = 0;
const n = () => ++k;
const tag = String(Date.now()).slice(-5);
/** 线索手机号：同一手机号只能有一条没结束的线索；p2 用 177 开头，这里用 178 开头加时间戳与序号，不会撞 */
const phone = () => `178${tag}${String(n()).padStart(3, '0')}`;
const BJ = 8 * 3600_000;
/** created_at（UTC ISO）→ 北京时间 YYYY-MM-DD HH:MM；null → '' */
const bj = (iso) => (iso ? new Date(Date.parse(iso) + BJ).toISOString().slice(0, 16).replace('T', ' ') : '');
const ymd = () => day(0).replaceAll('-', '');
const convert = async (leadId, as) => ok(await req('POST', `/api/leads/${leadId}/convert`, {}, { as }), 201);
const at = (lessons, date) => {
  const l = lessons.find((x) => x.date === date);
  assert.ok(l, `没有 ${date} 的课次`);
  return l;
};
/** 只比较期望里列出的字段：响应多带的字段（例如按命名约定另带的 *_name）不算错 */
const proj = (actual, expected) => {
  if (Array.isArray(expected) && Array.isArray(actual)) return actual.map((x, i) => (i < expected.length ? proj(x, expected[i]) : x));
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)) {
    return Object.fromEntries(Object.keys(expected).map((key) => [key, proj(actual[key], expected[key])]));
  }
  return actual;
};
const same = (actual, expected, msg) => assert.deepEqual(proj(actual, expected), expected, msg);
const cls = (sc, extra) => fx.publishedClass({ course: sc.course, campusId: sc.campus.id, roomId: sc.room.id, teacherId: sc.teacher.id, ...extra });

/** 严格按 RFC 4180 解析：记录之间必须是 \r\n；引号里的双引号写两遍；没加引号的字段里不能有双引号 */
function parseCsv(s) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      assert.ok(field === '' && !quoted, `第 ${rows.length + 1} 行：没加引号的字段里出现双引号`);
      inQ = true; quoted = true;
    } else if (c === ',') { row.push(field); field = ''; quoted = false; }
    else if (c === '\r') {
      assert.equal(s[i + 1], '\n', `第 ${rows.length + 1} 行：行尾应是 \\r\\n`);
      row.push(field); rows.push(row); row = []; field = ''; quoted = false; i++;
    } else if (c === '\n') assert.fail(`第 ${rows.length + 1} 行：行尾应是 \\r\\n，实际只有 \\n`);
    else {
      assert.ok(!quoted, `第 ${rows.length + 1} 行：引号外还有字符`);
      field += c;
    }
  }
  assert.ok(!inQ, '引号没有闭合');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
/** 取导出文件：断言 200、Content-Type、Content-Disposition 文件名、UTF-8 BOM，返回解析后的行（第一行是表头） */
async function csv(url, name) {
  const r = await fetch(`${rt.base}${url}`, { headers: { authorization: `Bearer ${rt.adminToken}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200, `期望 200，实际 ${r.status} ${buf.toString('utf8').slice(0, 200)}`);
  assert.match(r.headers.get('content-type') ?? '', /^text\/csv;\s*charset=utf-8$/i, `Content-Type: ${r.headers.get('content-type')}`);
  const cd = r.headers.get('content-disposition') ?? '';
  assert.match(cd, /^attachment\s*;/i, `Content-Disposition: ${cd}`);
  assert.ok(cd.includes(`filename="${name}-${ymd()}.csv"`), `Content-Disposition 应带 filename="${name}-${ymd()}.csv"，实际 ${cd}`);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '内容应以 UTF-8 BOM 开头');
  const text = buf.subarray(3).toString('utf8');
  return { text, rows: parseCsv(text) };
}

const AUDIT_ACTIONS = new Set(['user.create', 'user.update', 'user.delete', 'order.pay', 'order.cancel', 'refund.create', 'refund.approve', 'refund.reject',
  'course_transfer.create', 'wallet.withdraw', 'attendance.create', 'attendance.update', 'lesson.reschedule', 'lesson.substitute', 'lesson.cancel',
  'class.publish', 'class.finish', 'class.cancel', 'payroll.confirm', 'payroll.pay']);
const logs = (qs, as) => list(`/api/audit-logs?${qs}&page_size=100`, as);
/** PRD 只规定了这些操作要记；别的操作记不记没规定，比较时只看列出的这些 */
const listed = (items) => items.filter((x) => AUDIT_ACTIONS.has(x.action));

export async function run() {
  const me = await get('/api/auth/me');

  group('五期·看板');
  const D = {};
  const dash = (as) => get(`/api/reports/dashboard?campus_id=${D.sc.campus.id}`, as);
  await check('看板返回 9 个字段；campus_id 只统计这个校区；今天未取消的课次计入 today_lessons（取消班级带走的课次不算），还没点名时 today_completed 0、出勤率 null', async () => {
    const sc = await fx.school();
    D.sc = sc;
    const cid = sc.campus.id;
    const cId = sc.course.id;
    D.A = await cls(sc, { startDate: day(-1), lessonCount: 5 }); // day(-1)..day(3)
    D.B = await cls(sc, { startDate: day(0), lessonCount: 4 }); // day(0)..day(3)
    const C = await cls(sc, { startDate: day(0), lessonCount: 2 });
    const s = [];
    for (let i = 0; i < 8; i++) s.push(await fx.student(cid));
    D.s = s;
    // s0–s6 各买 10 节（每节 10000 分）：7 × 100000 = 700000
    for (let i = 0; i < 7; i++) await fx.paidOrder(s[i].id, [{ course_id: cId, lessons: 10 }]);
    // s7：一张待支付、一张已取消，都不产生收款
    await post('/api/orders', { student_id: s[7].id, items: [{ course_id: cId, lessons: 2 }], discount_id: null, note: '' });
    const oc = await post('/api/orders', { student_id: s[7].id, items: [{ course_id: cId, lessons: 1 }], discount_id: null, note: '' });
    await act(`/api/orders/${oc.id}/cancel`);
    for (const i of [0, 1, 2]) await fx.enroll(D.A.cls.id, s[i].id);
    for (const i of [0, 3, 4, 5]) await fx.enroll(D.B.cls.id, s[i].id);
    await fx.enroll(C.cls.id, s[6].id);
    await act(`/api/classes/${C.cls.id}/cancel`, { reason: '招生不足' });
    // 请假：s1 待审批；s2 已批准；s5 已驳回
    await post('/api/leaves', { student_id: s[1].id, lesson_id: at(D.A.lessons, day(2)).id, reason: '生病' });
    const lv1 = await post('/api/leaves', { student_id: s[2].id, lesson_id: at(D.A.lessons, day(3)).id, reason: '生病' });
    await act(`/api/leaves/${lv1.id}/approve`, { note: '' });
    const lv2 = await post('/api/leaves', { student_id: s[5].id, lesson_id: at(D.B.lessons, day(2)).id, reason: '有事' });
    await act(`/api/leaves/${lv2.id}/reject`, { note: '不批' });
    // 退费：s3 待审批 1 节；s4 退 2 节原路退回已批准：floor(100000 × 2 / 10) = 20000
    await post('/api/refunds', { student_id: s[3].id, course_id: cId, lessons: 1, to: 'original', reason: '搬家' });
    const rf = await post('/api/refunds', { student_id: s[4].id, course_id: cId, lessons: 2, to: 'original', reason: '搬家' });
    assert.equal(rf.amount, 20000);
    await act(`/api/refunds/${rf.id}/approve`, { method: 'cash' });
    // 线索：sales 负责 1 条今天要跟进；admin 负责 今天、明天、今天但已流失、没有跟进日期 各 1 条
    D.sa = await fx.user('sales');
    const lead = (as) => post('/api/leads', { name: `看板线索${n()}`, phone: phone(), source: 'online', campus_id: cid, grade: 3, interest_course_id: null, note: '' }, as);
    const follow = (id, date, as) => post(`/api/leads/${id}/follow-ups`, { method: 'phone', content: '电话沟通', next_follow_up: date }, as);
    const l1 = await lead(D.sa.token);
    await follow(l1.id, day(0), D.sa.token);
    const l2 = await lead();
    await follow(l2.id, day(0));
    const l3 = await lead();
    await follow(l3.id, day(1));
    const l4 = await lead();
    await follow(l4.id, day(0));
    await act(`/api/leads/${l4.id}/lose`, { reason: '不需要' });
    await lead();

    const all = await get('/api/reports/dashboard');
    assert.deepEqual(Object.keys(all).sort(), ['active_students', 'follow_ups_due', 'month_income', 'month_new_students', 'pending_leaves', 'pending_refunds', 'today_attendance_rate', 'today_completed', 'today_lessons']);
    const r = await dash();
    assert.equal(r.today_lessons, 2, 'A、B 今天各一节；C 今天的课随班级取消');
    assert.equal(r.today_completed, 0);
    assert.equal(r.today_attendance_rate, null);
  });
  await check('今天已点名的课次计入 today_completed；出勤率 (present+late)/(present+late+absent) 四舍五入：4/6 → 67', async () => {
    const s = D.s;
    // A：s0 出勤、s1 迟到、s2 缺勤；B：s0 出勤、s3 出勤、s4 请假、s5 缺勤 → present 3、late 1、absent 2
    await fx.attend(at(D.A.lessons, day(0)).id, { [s[1].id]: 'late', [s[2].id]: 'absent' });
    await fx.attend(at(D.B.lessons, day(0)).id, { [s[4].id]: 'leave', [s[5].id]: 'absent' });
    const r = await dash();
    assert.equal(r.today_lessons, 2);
    assert.equal(r.today_completed, 2);
    assert.equal(r.today_attendance_rate, 67);
  });
  await check('active_students 是当前在 active 班级里的学员（两个班都在的只算一次，班级取消后退班的不算）；month_new_students 是本月新建的学员', async () => {
    const r = await dash();
    assert.equal(r.active_students, 6, 's0–s5；s6 所在班级已取消，s7 没有分班');
    assert.equal(r.month_new_students, 8);
  });
  await check('month_income 是本月收款流水的 net：7 笔各 100000 的收款减去 20000 的原路退费 = 680000（待支付、已取消的订单不算）', async () => {
    assert.equal((await dash()).month_income, 680000);
  });
  await check('pending_leaves、pending_refunds 只数 pending 的请假与退费单', async () => {
    const r = await dash();
    assert.equal(r.pending_leaves, 1);
    assert.equal(r.pending_refunds, 1);
  });
  await check('follow_ups_due：next_follow_up 不晚于今天、没有结束的线索（admin 2 条）；sales 只算自己负责的（1 条），其他数字四个角色相同', async () => {
    const a = await dash();
    assert.equal(a.follow_ups_due, 2);
    const s = await dash(D.sa.token);
    assert.equal(s.follow_ups_due, 1);
    assert.deepEqual({ ...s, follow_ups_due: 2 }, a);
    const ac = await fx.user('academic');
    const fi = await fx.user('finance');
    assert.deepEqual(await dash(ac.token), a);
    assert.deepEqual(await dash(fi.token), a);
  });
  await check('看板：teacher、parent 403', async () => {
    fail(await req('GET', '/api/reports/dashboard', undefined, { as: D.sc.teacherToken }), 403);
    const p = await fx.user('parent');
    fail(await req('GET', '/api/reports/dashboard', undefined, { as: p.token }), 403);
  });

  group('五期·招生报表');
  const E = {};
  const enroll = (qs, as) => get(`/api/reports/enrollment?${qs}&campus_id=${E.sc.campus.id}`, as);
  await check('招生报表：这段时间新建的线索数、其中现在已转化的、转化率四舍五入（4/6 → 67）；试听按试听日期、不含取消的；订单按支付日期、应付金额之和', async () => {
    const sc = await fx.school();
    E.sc = sc;
    const cid = sc.campus.id;
    const cId = sc.course.id;
    E.sa = await fx.user('sales');
    const sa = E.sa.token;
    const lead = (source, as) => post('/api/leads', { name: `招生线索${n()}`, phone: phone(), source, campus_id: cid, grade: 4, interest_course_id: cId, note: '' }, as);
    const trial = (leadId, date, as, start_time = '10:00') => post('/api/trials', { lead_id: leadId, course_id: cId, campus_id: cid, teacher_id: null, date, start_time }, as);
    // L1 event（admin）：流失
    const L1 = await lead('event');
    await act(`/api/leads/${L1.id}/lose`, { reason: '不需要' });
    // L2 online（admin）：今天试听已到 → 转化
    const L2 = await lead('online');
    const t2 = await trial(L2.id, day(0));
    await act(`/api/trials/${t2.id}/complete`, { attended: true, feedback: '不错' });
    const st2 = await convert(L2.id);
    // L3 online（sales）：转化
    const L3 = await lead('online', sa);
    const st3 = await convert(L3.id, sa);
    // L4 referral（admin）：今天的试听取消了 → 转化
    const L4 = await lead('referral');
    const t4 = await trial(L4.id, day(0));
    await act(`/api/trials/${t4.id}/cancel`);
    const st4 = await convert(L4.id);
    // L5 walk_in（admin）：明天的试听 → 转化（试听还是 scheduled）
    const L5 = await lead('walk_in');
    await trial(L5.id, day(1));
    await convert(L5.id);
    // L6 walk_in（sales）：今天试听未到，再约今天下午一次（scheduled），没有转化
    const L6 = await lead('walk_in', sa);
    const t6 = await trial(L6.id, day(0), sa);
    await act(`/api/trials/${t6.id}/complete`, { attended: false, feedback: '' }, sa);
    await trial(L6.id, day(0), sa, '15:00');
    // 订单：admin 给 st2 买 10 节 = 100000；sales 给 st3 买 3 节减 5000 = 25000；st4 一张待支付
    await fx.paidOrder(st2.id, [{ course_id: cId, lessons: 10 }]);
    const disc = await post('/api/discounts', { name: `p5b立减${n()}`, type: 'amount', value: 5000, min_amount: 0, valid_from: null, valid_to: null });
    const o3 = await fx.paidOrder(st3.id, [{ course_id: cId, lessons: 3 }], { discount_id: disc.id, as: sa });
    assert.equal(o3.payable_amount, 25000);
    await post('/api/orders', { student_id: st4.id, items: [{ course_id: cId, lessons: 2 }], discount_id: null, note: '' });

    const r = await enroll(`from=${day(0)}&to=${day(0)}`);
    assert.equal(r.leads, 6);
    assert.equal(r.converted, 4);
    assert.equal(r.conversion_rate, 67);
    assert.equal(r.trials, 3, 'L2 已到、L6 未到、L6 已安排；L4 取消的、L5 明天的不算');
    assert.equal(r.trials_attended, 1);
    assert.equal(r.orders, 2);
    assert.equal(r.order_amount, 125000);
  });
  await check('by_source 只列有线索的来源，按 source 字母顺序，各带线索数与已转化数', async () => {
    const r = await enroll(`from=${day(0)}&to=${day(0)}`);
    same(r.by_source, [
      { source: 'event', leads: 1, converted: 0 },
      { source: 'online', leads: 2, converted: 2 },
      { source: 'referral', leads: 1, converted: 1 },
      { source: 'walk_in', leads: 2, converted: 1 },
    ]);
  });
  await check('owner_id：线索与试听只算这个人负责的线索，订单只算这个人创建的', async () => {
    const r = await enroll(`from=${day(0)}&to=${day(0)}&owner_id=${E.sa.user.id}`);
    same(r, {
      leads: 2, converted: 1, conversion_rate: 50,
      by_source: [{ source: 'online', leads: 1, converted: 1 }, { source: 'walk_in', leads: 1, converted: 0 }],
      trials: 2, trials_attended: 0, orders: 1, order_amount: 25000,
    });
  });
  await check('sales 总是只看自己的：不给 owner_id 与给别人的 owner_id 结果一样', async () => {
    const mine = await enroll(`from=${day(0)}&to=${day(0)}&owner_id=${E.sa.user.id}`);
    assert.deepEqual(await enroll(`from=${day(0)}&to=${day(0)}`, E.sa.token), mine);
    assert.deepEqual(await enroll(`from=${day(0)}&to=${day(0)}&owner_id=${me.id}`, E.sa.token), mine);
  });
  await check('换一段时间：没有新线索时 conversion_rate 为 null、by_source 为空；试听只按试听日期算（明天的 1 条）', async () => {
    same(await enroll(`from=${day(1)}&to=${day(1)}`), {
      leads: 0, converted: 0, conversion_rate: null, by_source: [], trials: 1, trials_attended: 0, orders: 0, order_amount: 0,
    });
  });
  await check('招生报表：from、to 必须给且 from 不晚于 to（400）；academic、finance、teacher 403', async () => {
    fail(await req('GET', `/api/reports/enrollment?to=${day(0)}`), 400);
    fail(await req('GET', `/api/reports/enrollment?from=${day(0)}`), 400);
    fail(await req('GET', `/api/reports/enrollment?from=${day(1)}&to=${day(0)}`), 400);
    for (const role of ['academic', 'finance']) {
      const u = await fx.user(role);
      fail(await req('GET', `/api/reports/enrollment?from=${day(0)}&to=${day(0)}`, undefined, { as: u.token }), 403);
    }
    fail(await req('GET', `/api/reports/enrollment?from=${day(0)}&to=${day(0)}`, undefined, { as: E.sc.teacherToken }), 403);
  });

  group('五期·消课与出勤报表');
  const C = {};
  const cons = (qs, as) => get(`/api/reports/consumption?${qs}&campus_id=${C.sc.campus.id}`, as);
  await check('消课报表：已点名与已取消的课次数、四种点名人次、扣课时人次；by_teacher 按上课教师、teacher_id 升序', async () => {
    const sc = await fx.school();
    C.sc = sc;
    const cid = sc.campus.id;
    C.course2 = await fx.course(sc.subject.id);
    C.t2 = (await fx.teacher(cid, [sc.subject.id])).teacher;
    // X：教师 T1、课程 1，day(-3)..day(1)；Y：教师 T2、课程 2，day(-2)..day(0)
    C.X = await cls(sc, { startDate: day(-3), lessonCount: 5 });
    C.Y = await fx.publishedClass({ course: C.course2, campusId: cid, roomId: sc.room.id, teacherId: C.t2.id, startDate: day(-2), lessonCount: 3 });
    const [a, b, e, d, c] = [await fx.student(cid), await fx.student(cid), await fx.student(cid), await fx.student(cid), await fx.student(cid)];
    Object.assign(C, { a, b, e, d, c });
    for (const s of [a, b, e, d]) await fx.paidOrder(s.id, [{ course_id: sc.course.id, lessons: 10 }]);
    await fx.paidOrder(c.id, [{ course_id: C.course2.id, lessons: 10 }]);
    for (const s of [a, b, e]) await fx.enroll(C.X.cls.id, s.id, day(-3));
    await fx.enroll(C.X.cls.id, d.id); // 今天加入，没有点名记录
    await fx.enroll(C.Y.cls.id, c.id, day(-2));
    const X = C.X.lessons;
    const Y = C.Y.lessons;
    await fx.attend(at(X, day(-3)).id, { [a.id]: 'present', [b.id]: 'late', [e.id]: 'leave' });
    await fx.attend(at(X, day(-2)).id, { [a.id]: 'absent', [b.id]: 'leave', [e.id]: 'leave' });
    await fx.attend(at(X, day(-1)).id, { [a.id]: 'present', [b.id]: 'present', [e.id]: 'leave' });
    await fx.attend(at(Y, day(-2)).id, { [c.id]: 'present' });
    await fx.attend(at(Y, day(-1)).id, { [c.id]: 'absent' });
    await fx.attend(at(Y, day(0)).id, { [c.id]: 'leave' });
    await act(`/api/lessons/${at(X, day(1)).id}/cancel`, { reason: '停课', append: false });
    // X：present 3、late 1、absent 1、leave 4，扣 5；Y：present 1、absent 1、leave 1，扣 2
    const r = await cons(`from=${day(-3)}&to=${day(1)}`);
    const T1 = { teacher_id: sc.teacher.id, teacher_name: sc.teacher.name, lessons: 3, consumed_lessons: 5 };
    const T2 = { teacher_id: C.t2.id, teacher_name: C.t2.name, lessons: 3, consumed_lessons: 2 };
    same(r, {
      lessons_completed: 6, lessons_cancelled: 1,
      attendance: { present: 4, late: 1, absent: 2, leave: 5 },
      consumed_lessons: 7,
      by_teacher: sc.teacher.id < C.t2.id ? [T1, T2] : [T2, T1],
    });
  });
  await check('消课报表按课次日期筛选（含两端）：只看 day(-1)', async () => {
    const r = await cons(`from=${day(-1)}&to=${day(-1)}`);
    const T1 = { teacher_id: C.sc.teacher.id, teacher_name: C.sc.teacher.name, lessons: 1, consumed_lessons: 2 };
    const T2 = { teacher_id: C.t2.id, teacher_name: C.t2.name, lessons: 1, consumed_lessons: 1 };
    same(r, {
      lessons_completed: 2, lessons_cancelled: 0,
      attendance: { present: 2, late: 0, absent: 1, leave: 1 },
      consumed_lessons: 3,
      by_teacher: C.sc.teacher.id < C.t2.id ? [T1, T2] : [T2, T1],
    });
  });
  await check('消课报表的 teacher_id、course_id 筛选', async () => {
    same(await cons(`from=${day(-3)}&to=${day(1)}&teacher_id=${C.t2.id}`), {
      lessons_completed: 3, lessons_cancelled: 0,
      attendance: { present: 1, late: 0, absent: 1, leave: 1 },
      consumed_lessons: 2,
      by_teacher: [{ teacher_id: C.t2.id, teacher_name: C.t2.name, lessons: 3, consumed_lessons: 2 }],
    });
    same(await cons(`from=${day(-3)}&to=${day(1)}&course_id=${C.sc.course.id}`), {
      lessons_completed: 3, lessons_cancelled: 1,
      attendance: { present: 3, late: 1, absent: 1, leave: 4 },
      consumed_lessons: 5,
      by_teacher: [{ teacher_id: C.sc.teacher.id, teacher_name: C.sc.teacher.name, lessons: 3, consumed_lessons: 5 }],
    });
  });
  await check('消课报表：from、to 必须给（400）；finance 能看，sales、teacher 403', async () => {
    fail(await req('GET', `/api/reports/consumption?from=${day(0)}`), 400);
    fail(await req('GET', `/api/reports/consumption?to=${day(0)}`), 400);
    const f = await fx.user('finance');
    ok(await req('GET', `/api/reports/consumption?from=${day(0)}&to=${day(0)}`, undefined, { as: f.token }));
    const s = await fx.user('sales');
    fail(await req('GET', `/api/reports/consumption?from=${day(0)}&to=${day(0)}`, undefined, { as: s.token }), 403);
    fail(await req('GET', `/api/reports/consumption?from=${day(0)}&to=${day(0)}`, undefined, { as: C.sc.teacherToken }), 403);
  });
  await check('班级出勤报表：每个有点名记录的学员一项、按 student_id 升序，rate 四舍五入（2/3 → 67），分母为 0 时 null；没有记录的学员不列', async () => {
    const r = await get(`/api/reports/attendance?class_id=${C.X.cls.id}`);
    const row = (s, present, late, absent, leave, rate) => ({ student_id: s.id, name: s.name, no: s.no, present, late, absent, leave, rate });
    same(r, [row(C.a, 2, 0, 1, 0, 67), row(C.b, 1, 1, 0, 1, 100), row(C.e, 0, 0, 0, 3, null)].sort((x, y) => x.student_id - y.student_id));
  });
  await check('班级出勤报表：必须给 class_id，班级不存在 400；academic 能看，teacher、sales 403', async () => {
    fail(await req('GET', '/api/reports/attendance'), 400);
    fail(await req('GET', '/api/reports/attendance?class_id=999999'), 400);
    const ac = await fx.user('academic');
    ok(await req('GET', `/api/reports/attendance?class_id=${C.X.cls.id}`, undefined, { as: ac.token }));
    fail(await req('GET', `/api/reports/attendance?class_id=${C.X.cls.id}`, undefined, { as: C.sc.teacherToken }), 403);
    const s = await fx.user('sales');
    fail(await req('GET', `/api/reports/attendance?class_id=${C.X.cls.id}`, undefined, { as: s.token }), 403);
  });

  group('五期·余额预警');
  const L = {};
  const low = (qs = '', as) => get(`/api/reports/low-balance?campus_id=${L.sc.campus.id}${qs}`, as);
  const lb = (s, course, remaining, classes) => ({ student_id: s.id, student_name: s.name, course_id: course.id, course_name: course.name, remaining, class_ids: classes.map((c) => c.id), class_names: classes.map((c) => c.name) });
  await check('余额预警（默认 threshold 3）：当前在 active 班级里、这门课程余额不超过 3 的学员与课程，按 remaining、student_id、course_id 升序；class_ids 升序、class_names 一一对应', async () => {
    const sc = await fx.school();
    L.sc = sc;
    const cid = sc.campus.id;
    const K1 = sc.course;
    const K2 = await fx.course(sc.subject.id);
    L.K1 = K1; L.K2 = K2;
    const { cls: P1, lessons: P1lessons } = await cls(sc, { startDate: day(-1), lessonCount: 3 });
    const P2 = (await cls(sc, { startDate: day(0), lessonCount: 3 })).cls;
    const Q1 = (await fx.publishedClass({ course: K2, campusId: cid, roomId: sc.room.id, teacherId: sc.teacher.id, startDate: day(0), lessonCount: 3 })).cls;
    const Z = await post('/api/classes', { name: `筹备班${n()}`, course_id: K1.id, campus_id: cid, room_id: sc.room.id, teacher_id: sc.teacher.id, term_id: null, capacity: 10, start_date: day(5), schedule: [{ weekday: 1, start_time: fx.slot() }], lesson_count: 3 });
    Object.assign(L, { P1, P2, Q1 });
    const s = [];
    for (let i = 0; i < 8; i++) s.push(await fx.student(cid));
    L.s = s;
    const buy = (st, course, lessons) => fx.paidOrder(st.id, [{ course_id: course.id, lessons }]);
    await buy(s[0], K1, 2); await fx.enroll(P1.id, s[0].id);
    await buy(s[1], K1, 3); await fx.enroll(P1.id, s[1].id); await fx.enroll(P2.id, s[1].id);
    await buy(s[2], K1, 4); await fx.enroll(P1.id, s[2].id);
    await buy(s[3], K1, 10); await buy(s[3], K2, 1); await fx.enroll(P1.id, s[3].id); await fx.enroll(Q1.id, s[3].id);
    await buy(s[4], K1, 1); await fx.enroll(Z.id, s[4].id); // 只在筹备中的班级
    await buy(s[5], K1, 1); await fx.enroll(P1.id, s[5].id);
    const r = await req('DELETE', `/api/classes/${P1.id}/students/${s[5].id}`); // 退班
    assert.equal(r.status, 204, r.text.slice(0, 200));
    await buy(s[6], K1, 2); await fx.enroll(P1.id, s[6].id, day(-1));
    await buy(s[7], K1, 1); await fx.enroll(P1.id, s[7].id, day(-1));
    await fx.attend(at(P1lessons, day(-1)).id); // s6、s7 出勤各扣 1 → 余额 1、0
    same(await low(), [
      lb(s[7], K1, 0, [P1]),
      lb(s[3], K2, 1, [Q1]),
      lb(s[6], K1, 1, [P1]),
      lb(s[0], K1, 2, [P1]),
      lb(s[1], K1, 3, [P1, P2]),
    ]);
  });
  await check('余额预警的 threshold：0 只列余额为 0 的；4、20 依次多出余额 4、10 的', async () => {
    const { s, K1, K2, P1, P2, Q1 } = L;
    same(await low('&threshold=0'), [lb(s[7], K1, 0, [P1])]);
    const four = [lb(s[7], K1, 0, [P1]), lb(s[3], K2, 1, [Q1]), lb(s[6], K1, 1, [P1]), lb(s[0], K1, 2, [P1]), lb(s[1], K1, 3, [P1, P2]), lb(s[2], K1, 4, [P1])];
    same(await low('&threshold=4'), four);
    same(await low('&threshold=20'), [...four, lb(s[3], K1, 10, [P1])]);
  });
  await check('threshold 不是 0–20 的整数 400', async () => {
    for (const t of ['21', '-1', 'abc', '1.5']) fail(await req('GET', `/api/reports/low-balance?threshold=${t}`), 400);
  });
  await check('余额预警：sales、academic 能看，finance、teacher 403', async () => {
    for (const role of ['sales', 'academic']) {
      const u = await fx.user(role);
      ok(await req('GET', `/api/reports/low-balance?campus_id=${L.sc.campus.id}`, undefined, { as: u.token }));
    }
    const f = await fx.user('finance');
    fail(await req('GET', '/api/reports/low-balance', undefined, { as: f.token }), 403);
    fail(await req('GET', '/api/reports/low-balance', undefined, { as: L.sc.teacherToken }), 403);
  });

  group('五期·导出 CSV');
  const X = {};
  const GENDER = { male: '男', female: '女', unknown: '未知' };
  const SSTATUS = { active: '在读', inactive: '停读' };
  const studentRow = (s) => [s.no, s.name, GENDER[s.gender], s.grade == null ? '' : String(s.grade), X.campus.name, s.phone, SSTATUS[s.status]];
  await check('学员导出：Content-Type text/csv; charset=utf-8，文件名 students-今天.csv，UTF-8 BOM，\\r\\n 行尾，表头照写', async () => {
    X.campus = await fx.campus({ name: `导出,"东区"${n()}` });
    X.students = [];
    for (let i = 0; i < 20; i++) X.students.push(await fx.student(X.campus.id));
    X.students.push(await fx.student(X.campus.id, { name: '张"小"三,二', gender: 'female', grade: 4, phone: '+86 138-0000-0001' }));
    const s2 = await fx.student(X.campus.id, { name: '李\n四', gender: 'male', grade: null });
    X.students.push(await patch(`/api/students/${s2.id}`, { status: 'inactive' }));
    X.students.push(await fx.student(X.campus.id, { gender: 'unknown', grade: 12 }));
    const { rows, text } = await csv(`/api/exports/students.csv?campus_id=${X.campus.id}`, 'students');
    assert.deepEqual(rows[0], ['学号', '姓名', '性别', '年级', '校区', '手机', '状态']);
    assert.ok(text.endsWith('\r\n'), '最后一行也应以 \\r\\n 结尾');
  });
  await check('学员导出：不分页（23 条全部导出）、顺序同列表（id 降序）；性别、年级、状态的写法；含逗号、双引号、换行的字段正确转义', async () => {
    const { rows, text } = await csv(`/api/exports/students.csv?campus_id=${X.campus.id}`, 'students');
    const want = [...X.students].sort((a, b) => b.id - a.id).map(studentRow);
    assert.deepEqual(rows.slice(1), want);
    assert.ok(text.includes('"张""小""三,二"'), '含双引号与逗号的姓名应写成 "张""小""三,二"');
    assert.ok(text.includes(`"导出,""东区""`), '含逗号与双引号的校区名应加引号、双引号写两遍');
  });
  await check('学员导出的筛选同学员列表（campus_id + status）', async () => {
    const { rows } = await csv(`/api/exports/students.csv?campus_id=${X.campus.id}&status=inactive`, 'students');
    assert.deepEqual(rows.slice(1), X.students.filter((s) => s.status === 'inactive').map(studentRow));
  });
  await check('订单导出：表头、金额写成元两位小数、状态与支付方式中文、时间北京 YYYY-MM-DD HH:MM、没有的空着；按 student_id 筛选、id 降序', async () => {
    const sc = await fx.school({ price_per_lesson: 12345 });
    X.sc = sc;
    const st = await fx.student(sc.campus.id, { name: '王,五' });
    X.st = st;
    const disc = await post('/api/discounts', { name: `p5b立减5分${n()}`, type: 'amount', value: 5, min_amount: 0, valid_from: null, valid_to: null });
    // 3 节 × 12345 = 37035，减 5 = 37030
    const paid = await fx.paidOrder(st.id, [{ course_id: sc.course.id, lessons: 3 }], { method: 'card', discount_id: disc.id });
    assert.equal(paid.original_amount, 37035); assert.equal(paid.payable_amount, 37030);
    const pending = await post('/api/orders', { student_id: st.id, items: [{ course_id: sc.course.id, lessons: 2 }], discount_id: null, note: '' }); // 24690
    const cancelled = await post('/api/orders', { student_id: st.id, items: [{ course_id: sc.course.id, lessons: 1 }], discount_id: null, note: '' }); // 12345
    await act(`/api/orders/${cancelled.id}/cancel`);
    const { rows } = await csv(`/api/exports/orders.csv?student_id=${st.id}`, 'orders');
    assert.deepEqual(rows[0], ['单号', '学号', '学员', '原价', '优惠', '应付', '状态', '支付方式', '下单时间', '支付时间']);
    assert.deepEqual(rows.slice(1), [
      [cancelled.no, st.no, st.name, '123.45', '0.00', '123.45', '已取消', '', bj(cancelled.created_at), ''],
      [pending.no, st.no, st.name, '246.90', '0.00', '246.90', '待支付', '', bj(pending.created_at), ''],
      [paid.no, st.no, st.name, '370.35', '0.05', '370.30', '已支付', '刷卡', bj(paid.created_at), bj(paid.paid_at)],
    ]);
  });
  await check('收款导出：表头、类型与方式中文、负数金额 -123.43、时间北京；按 student_id 筛选、id 降序', async () => {
    const { st, sc } = X;
    // 原路退 1 节：floor(37030 × 1 / 3) = 12343；再退 1 节到余额：12343；取现 10000
    const r1 = await post('/api/refunds', { student_id: st.id, course_id: sc.course.id, lessons: 1, to: 'original', reason: '退费' });
    assert.equal(r1.amount, 12343);
    await act(`/api/refunds/${r1.id}/approve`, { method: 'transfer' });
    const r2 = await post('/api/refunds', { student_id: st.id, course_id: sc.course.id, lessons: 1, to: 'balance', reason: '退到余额' });
    await act(`/api/refunds/${r2.id}/approve`, {});
    await act(`/api/students/${st.id}/wallet/withdraw`, { amount: 10000, method: 'alipay' });
    const ps = await list(`/api/payments?student_id=${st.id}`);
    assert.deepEqual(pluck(ps, 'amount'), [-10000, -12343, 37030]);
    const { rows } = await csv(`/api/exports/payments.csv?student_id=${st.id}`, 'payments');
    assert.deepEqual(rows[0], ['流水号', '类型', '学号', '学员', '金额', '方式', '时间']);
    assert.deepEqual(rows.slice(1), [
      [ps[0].no, '取现', st.no, st.name, '-100.00', '支付宝', bj(ps[0].created_at)],
      [ps[1].no, '退费', st.no, st.name, '-123.43', '转账', bj(ps[1].created_at)],
      [ps[2].no, '收款', st.no, st.name, '370.30', '刷卡', bj(ps[2].created_at)],
    ]);
  });
  await check('考勤导出：表头、内容同班级出勤报表，出勤率写成 67%，没有时空着', async () => {
    const { rows } = await csv(`/api/exports/attendance.csv?class_id=${C.X.cls.id}`, 'attendance');
    assert.deepEqual(rows[0], ['学号', '姓名', '出勤', '迟到', '缺勤', '请假', '出勤率']);
    const want = [[C.a, '2', '0', '1', '0', '67%'], [C.b, '1', '1', '0', '1', '100%'], [C.e, '0', '0', '0', '3', '']]
      .sort((x, y) => x[0].id - y[0].id).map(([s, ...rest]) => [s.no, s.name, ...rest]);
    assert.deepEqual(rows.slice(1), want);
  });
  await check('导出的角色：finance 不能导学员、academic 不能导订单、sales 不能导收款、teacher 不能导考勤（403）；考勤不给 class_id 400', async () => {
    const f = await fx.user('finance');
    const ac = await fx.user('academic');
    const s = await fx.user('sales');
    fail(await req('GET', '/api/exports/students.csv', undefined, { as: f.token }), 403);
    fail(await req('GET', '/api/exports/orders.csv', undefined, { as: ac.token }), 403);
    fail(await req('GET', '/api/exports/payments.csv', undefined, { as: s.token }), 403);
    fail(await req('GET', `/api/exports/attendance.csv?class_id=${C.X.cls.id}`, undefined, { as: C.sc.teacherToken }), 403);
    fail(await req('GET', '/api/exports/attendance.csv'), 400);
    // 有权限的角色能导
    assert.equal((await req('GET', `/api/exports/orders.csv?student_id=${X.st.id}`, undefined, { as: f.token })).status, 200);
    assert.equal((await req('GET', `/api/exports/students.csv?campus_id=${X.campus.id}`, undefined, { as: s.token })).status, 200);
  });

  group('五期·操作日志');
  const G = {};
  const shape = (x) => {
    for (const key of ['id', 'user_id', 'username', 'user_name', 'action', 'target_type', 'target_id', 'detail', 'created_at']) assert.ok(key in x, `日志缺少 ${key}`);
    assert.equal(typeof x.detail, 'string'); assert.ok(x.detail.length > 0, 'detail 应是简短的中文说明');
    assert.match(x.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  };
  const descending = (items) => assert.deepEqual(pluck(items, 'id'), [...pluck(items, 'id')].sort((a, b) => b - a), '应按 id 降序');
  await check('用户的创建、修改、删除各记一条（user_id、username 是操作人，target 是被操作的用户），按 id 降序', async () => {
    const u = await fx.user('sales');
    await patch(`/api/users/${u.user.id}`, { name: '改过的名字' });
    assert.equal((await req('DELETE', `/api/users/${u.user.id}`)).status, 204);
    G.userId = u.user.id;
    const items = await logs(`target_type=user&target_id=${u.user.id}`);
    items.forEach(shape);
    descending(items);
    const mine = listed(items);
    assert.deepEqual(pluck(mine, 'action'), ['user.delete', 'user.update', 'user.create']);
    for (const x of mine) {
      assert.equal(x.user_id, me.id); assert.equal(x.username, 'admin'); assert.equal(x.user_name, me.name);
      assert.equal(x.target_type, 'user'); assert.equal(x.target_id, u.user.id);
    }
  });
  await check('订单支付、取消记日志（操作人是 sales）；支付失败（金额不对 400）不记', async () => {
    const sc = await fx.school();
    const sa = await fx.user('sales');
    const st = await fx.student(sc.campus.id);
    const o1 = await post('/api/orders', { student_id: st.id, items: [{ course_id: sc.course.id, lessons: 2 }], discount_id: null, note: '' }, sa.token);
    fail(await req('POST', `/api/orders/${o1.id}/pay`, { method: 'cash', amount: o1.payable_amount - 1 }, { as: sa.token }), 400);
    assert.deepEqual(listed(await logs(`target_type=order&target_id=${o1.id}`)), []);
    await act(`/api/orders/${o1.id}/pay`, { method: 'cash', amount: o1.payable_amount }, sa.token);
    const o2 = await post('/api/orders', { student_id: st.id, items: [{ course_id: sc.course.id, lessons: 1 }], discount_id: null, note: '' }, sa.token);
    await act(`/api/orders/${o2.id}/cancel`, {}, sa.token);
    const pay = listed(await logs(`target_type=order&target_id=${o1.id}`));
    assert.deepEqual(pay.map((x) => [x.action, x.user_id, x.username, x.user_name, x.target_type, x.target_id]), [['order.pay', sa.user.id, sa.user.username, sa.user.name, 'order', o1.id]]);
    const cancel = listed(await logs(`target_type=order&target_id=${o2.id}`));
    assert.deepEqual(cancel.map((x) => [x.action, x.user_id, x.username]), [['order.cancel', sa.user.id, sa.user.username]]);
    G.sc = sc; G.sa = sa; G.st = st;
  });
  await check('退费的创建（sales）、批准与驳回（finance）记在退费单上；余额取现记在学员上（target_type student）；转课记在转课单上', async () => {
    const { sc, sa, st } = G;
    const fi = await fx.user('finance');
    await fx.paidOrder(st.id, [{ course_id: sc.course.id, lessons: 4 }], { as: sa.token }); // 共 6 节
    const r1 = await post('/api/refunds', { student_id: st.id, course_id: sc.course.id, lessons: 1, to: 'balance', reason: '退到余额' }, sa.token);
    await act(`/api/refunds/${r1.id}/approve`, {}, fi.token);
    const r2 = await post('/api/refunds', { student_id: st.id, course_id: sc.course.id, lessons: 1, to: 'original', reason: '再退' }, sa.token);
    await act(`/api/refunds/${r2.id}/reject`, { reason: '不符合规定' }, fi.token);
    await act(`/api/students/${st.id}/wallet/withdraw`, { amount: 1000, method: 'cash' }, fi.token);
    const course2 = await fx.course(sc.subject.id);
    const ct = await post('/api/course-transfers', { student_id: st.id, from_course_id: sc.course.id, to_course_id: course2.id, lessons: 1 }, sa.token);
    const view = async (qs) => listed(await logs(qs)).map((x) => [x.action, x.user_id, x.username]);
    assert.deepEqual(await view(`target_type=refund&target_id=${r1.id}`), [['refund.approve', fi.user.id, fi.user.username], ['refund.create', sa.user.id, sa.user.username]]);
    assert.deepEqual(await view(`target_type=refund&target_id=${r2.id}`), [['refund.reject', fi.user.id, fi.user.username], ['refund.create', sa.user.id, sa.user.username]]);
    assert.deepEqual(await view(`target_type=student&target_id=${st.id}`), [['wallet.withdraw', fi.user.id, fi.user.username]]);
    assert.deepEqual(await view(`target_type=course_transfer&target_id=${ct.id}`), [['course_transfer.create', sa.user.id, sa.user.username]]);
  });
  await check('班级发布、取消记在班级上；调课、代课、停课记在课次上（操作人是 academic）', async () => {
    const sc = await fx.school();
    const ac = await fx.user('academic');
    const t2 = (await fx.teacher(sc.campus.id, [sc.subject.id])).teacher;
    const k1 = await cls(sc, { startDate: day(2), lessonCount: 3 });
    const [l1, l2, l3] = k1.lessons;
    await act(`/api/lessons/${l1.id}/reschedule`, { date: day(40), start_time: l1.start_time }, ac.token);
    await act(`/api/lessons/${l2.id}/substitute`, { teacher_id: t2.id }, ac.token);
    await act(`/api/lessons/${l3.id}/cancel`, { reason: '停课', append: false }, ac.token);
    const k2 = await post('/api/classes', { name: `待取消班${n()}`, course_id: sc.course.id, campus_id: sc.campus.id, room_id: sc.room.id, teacher_id: sc.teacher.id, term_id: null, capacity: 10, start_date: day(5), schedule: [{ weekday: 1, start_time: fx.slot() }], lesson_count: 2 });
    await act(`/api/classes/${k2.id}/cancel`, { reason: '不开了' }, ac.token);
    const view = async (qs) => listed(await logs(qs)).map((x) => [x.action, x.user_id, x.username]);
    assert.deepEqual(await view(`target_type=class&target_id=${k1.cls.id}`), [['class.publish', me.id, 'admin']]);
    assert.deepEqual(await view(`target_type=class&target_id=${k2.id}`), [['class.cancel', ac.user.id, ac.user.username]]);
    assert.deepEqual(await view(`target_type=lesson&target_id=${l1.id}`), [['lesson.reschedule', ac.user.id, ac.user.username]]);
    assert.deepEqual(await view(`target_type=lesson&target_id=${l2.id}`), [['lesson.substitute', ac.user.id, ac.user.username]]);
    assert.deepEqual(await view(`target_type=lesson&target_id=${l3.id}`), [['lesson.cancel', ac.user.id, ac.user.username]]);
  });
  await check('点名记一条（按 user_id、action 筛选，操作人是教师）；结课记在班级上', async () => {
    const sc = await fx.school();
    const k = await cls(sc, { startDate: day(0), lessonCount: 1 });
    const st = await fx.student(sc.campus.id);
    await fx.paidOrder(st.id, [{ course_id: sc.course.id, lessons: 2 }]);
    await fx.enroll(k.cls.id, st.id);
    await fx.attend(k.lessons[0].id, {}, { as: sc.teacherToken });
    await act(`/api/classes/${k.cls.id}/finish`);
    const att = await logs(`user_id=${sc.teacherUser.id}&action=attendance.create`);
    assert.equal(att.length, 1);
    assert.equal(att[0].action, 'attendance.create'); assert.equal(att[0].user_id, sc.teacherUser.id); assert.equal(att[0].username, sc.teacherUser.username);
    assert.equal(att[0].target_type, 'lesson', '点名的 target_type 是 lesson'); assert.equal(att[0].target_id, k.lessons[0].id);
    assert.deepEqual(pluck(listed(await logs(`target_type=class&target_id=${k.cls.id}`)), 'action'), ['class.finish', 'class.publish']);
  });
  await check('工资单的确认、发放各记一条（target_type payroll，操作人是 finance）', async () => {
    const fi = await fx.user('finance');
    // 远离 p4 用过的月份；这个月没有课次，lines 为空也照样生成
    const p = await post('/api/payrolls', { month: '2039-07' }, fi.token);
    await act(`/api/payrolls/${p.id}/confirm`, {}, fi.token);
    await act(`/api/payrolls/${p.id}/pay`, {}, fi.token);
    const items = listed(await logs(`target_type=payroll&target_id=${p.id}`));
    assert.deepEqual(items.map((x) => [x.action, x.user_id, x.username, x.user_name, x.target_type, x.target_id]), [
      ['payroll.pay', fi.user.id, fi.user.username, fi.user.name, 'payroll', p.id],
      ['payroll.confirm', fi.user.id, fi.user.username, fi.user.name, 'payroll', p.id],
    ]);
  });
  await check('操作日志的 user_id、action、from/to（created_at 的北京日期）筛选', async () => {
    const byAction = await logs(`action=user.create&user_id=${me.id}`);
    assert.ok(byAction.length > 0);
    assert.ok(byAction.every((x) => x.action === 'user.create' && x.user_id === me.id));
    assert.ok(byAction.some((x) => x.target_id === G.userId));
    descending(byAction);
    assert.equal(listed(await logs(`target_type=user&target_id=${G.userId}&from=${day(0)}&to=${day(0)}`)).length, 3);
    assert.deepEqual(await logs(`target_type=user&target_id=${G.userId}&from=${day(1)}`), []);
    assert.deepEqual(await logs(`target_type=user&target_id=${G.userId}&to=${day(-1)}`), []);
  });
  await check('操作日志只有 admin 能看：academic、finance、sales 403', async () => {
    for (const role of ['academic', 'finance', 'sales']) {
      const u = await fx.user(role);
      fail(await req('GET', '/api/audit-logs', undefined, { as: u.token }), 403);
    }
  });
  await check('操作日志不能修改或删除（PATCH、DELETE 不成功），记录不变', async () => {
    const [x] = await logs(`target_type=user&target_id=${G.userId}&action=user.create`);
    assert.ok(x, '应有 user.create 这一条');
    for (const [m, body] of [['PATCH', { detail: '改掉' }], ['PUT', { detail: '改掉' }], ['DELETE', undefined]]) {
      const r = await req(m, `/api/audit-logs/${x.id}`, body);
      assert.ok(r.status < 200 || r.status >= 300, `${m} 不应成功，实际 ${r.status}`);
    }
    assert.deepEqual(await logs(`target_type=user&target_id=${G.userId}&action=user.create`), [x]);
  });
}
