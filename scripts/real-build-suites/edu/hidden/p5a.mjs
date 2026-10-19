// 第五期（上）：作业、提交与批改、考试与成绩、课堂反馈、家长端、站内通知、公告（REQ-038–REQ-044）。
// 不建工资单、不做点名更正（PUT attendance）：工资单只有 p4 建，payroll_confirmed 通知这里不测。
import { act, addDays, assert, check, day, del, fail, fx, get, group, list, ok, patch, pluck, post, put, req, weekday } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 这个日期所在周的周一 */
const mondayOf = (date) => addDays(date, 1 - weekday(date));
/** 当前用户的全部通知（分页列表，取 100 条足够：每个用户都是本文件新建的） */
const notes = async (token, q = '') => list(`/api/notifications?page_size=100${q}`, token);
const notesOf = async (token, refType, refId) => (await notes(token)).filter((n) => n.ref_type === refType && n.ref_id === refId);

/**
 * 公共数据：一个校区，班级 X 从 day(-5) 起每天一节共 12 节（day(-5) … day(6)），
 * 学员 A、B、C、D、E、G 都 day(-5) 入班、各买 20 节；D 准备完就退班（退班日期是今天）。
 * day(-1) 的课点名：A present、B late、C absent、D present、E leave、G present。
 * 家长：P1 绑 A、B（下单前绑，会收到 order_paid）；P2 绑 C；P3 是 A 的第二个家长；P4 绑 E、G；P5 只绑 D。
 */
async function setup() {
  const sch = await fx.school();
  const S = { sch, campus: sch.campus, course: sch.course, T: { teacher: sch.teacher, user: sch.teacherUser, token: sch.teacherToken } };
  S.T2 = await fx.teacher(sch.campus.id, [sch.subject.id]);
  const mk = () => fx.student(sch.campus.id);
  S.A = await mk(); S.B = await mk(); S.C = await mk(); S.D = await mk(); S.E = await mk(); S.G = await mk();
  S.P1 = await fx.parentOf([S.A.id, S.B.id]);
  S.orderA = await fx.paidOrder(S.A.id, [{ course_id: sch.course.id, lessons: 20 }]);
  S.orderB = await fx.paidOrder(S.B.id, [{ course_id: sch.course.id, lessons: 20 }]);
  for (const s of [S.C, S.D, S.E, S.G]) await fx.paidOrder(s.id, [{ course_id: sch.course.id, lessons: 20 }]);
  S.P2 = await fx.parentOf([S.C.id]);
  S.P3 = await fx.parentOf([S.A.id], 'father');
  S.P4 = await fx.parentOf([S.E.id, S.G.id]);
  S.P5 = await fx.parentOf([S.D.id]);
  const x = await fx.publishedClass({ course: sch.course, campusId: sch.campus.id, roomId: sch.room.id, teacherId: sch.teacher.id, startDate: day(-5), lessonCount: 12 });
  S.X = x.cls; S.lessons = x.lessons;
  S.L = (n) => { const l = S.lessons.find((v) => v.date === day(n)); assert.ok(l, `班级 X 没有 ${day(n)} 的课次`); return l; };
  for (const s of [S.A, S.B, S.C, S.D, S.E, S.G]) await fx.enroll(S.X.id, s.id, day(-5));
  await del(`/api/classes/${S.X.id}/students/${S.D.id}`);
  await fx.attend(S.L(-1).id, { [S.B.id]: 'late', [S.C.id]: 'absent', [S.E.id]: 'leave' });
  // 班级 Y：day(2) 起 3 节，之后取消（测结课、取消后的班级）
  const y = await fx.publishedClass({ course: sch.course, campusId: sch.campus.id, roomId: sch.room.id, teacherId: sch.teacher.id, startDate: day(2), lessonCount: 3 });
  S.Y = y.cls; S.yLessons = y.lessons;
  // 班级 Z：筹备中（不发布）
  S.Z = await post('/api/classes', { name: '筹备班', course_id: sch.course.id, campus_id: sch.campus.id, room_id: sch.room.id, teacher_id: sch.teacher.id, term_id: null, capacity: 10, start_date: day(20), schedule: [{ weekday: 1, start_time: fx.slot() }], lesson_count: 2 });
  return S;
}

export async function run() {
  let S;
  try { S = await setup(); } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    S = new Proxy({}, { get() { throw new Error(`五期准备数据失败：${msg}`); } });
  }
  const ids = {};

  group('五期·作业');
  await check('教师给自己的班布置作业：201，lesson_id 为 null 时 lesson_seq、lesson_date 为 null，带 class_name、submitted_count 0、student_count 为当前在班人数，created_by 是教师用户', async () => {
    const h = ok(await req('POST', '/api/homeworks', { class_id: S.X.id, lesson_id: null, title: ' 口算练习 ', content: '第 1–20 题', due_date: day(3) }, { as: S.T.token }), 201);
    assert.equal(h.class_id, S.X.id); assert.equal(h.class_name, S.X.name); assert.equal(h.title, '口算练习');
    assert.equal(h.lesson_id, null); assert.equal(h.lesson_seq, null); assert.equal(h.lesson_date, null);
    assert.equal(h.submitted_count, 0); assert.equal(h.student_count, 5, 'A、B、C、E、G 在班，D 已退班');
    assert.equal(h.created_by, S.T.user.id); assert.equal(h.due_date, day(3)); assert.equal(typeof h.created_at, 'string');
    ids.hw1 = h.id;
  });
  await check('作业关联本班课次时带 lesson_seq、lesson_date；别的班的课次、截止日期早于今天、标题为空、内容超过 2000 字 400', async () => {
    const l2 = S.L(2);
    const h = await post('/api/homeworks', { class_id: S.X.id, lesson_id: l2.id, title: '预习', content: '读课文', due_date: day(5) });
    assert.equal(h.lesson_id, l2.id); assert.equal(h.lesson_seq, l2.seq); assert.equal(h.lesson_date, l2.date);
    ids.hw2 = h.id;
    const base = { class_id: S.X.id, lesson_id: null, title: 't', content: 'c', due_date: day(3) };
    fail(await req('POST', '/api/homeworks', { ...base, lesson_id: S.yLessons[0].id }), 400);
    fail(await req('POST', '/api/homeworks', { ...base, due_date: day(-1) }), 400);
    fail(await req('POST', '/api/homeworks', { ...base, title: '   ' }), 400);
    fail(await req('POST', '/api/homeworks', { ...base, content: 'x'.repeat(2001) }), 400);
  });
  await check('作业列表 class_id 筛选，按 due_date 降序、再按 id 降序（分页结构）', async () => {
    ids.hw3 = (await post('/api/homeworks', { class_id: S.X.id, lesson_id: null, title: '复习', content: '复习', due_date: day(5) })).id;
    const items = await list(`/api/homeworks?class_id=${S.X.id}&page_size=100`);
    assert.deepEqual(pluck(items, 'id'), [ids.hw3, ids.hw2, ids.hw1]);
  });
  await check('teacher 只能管自己班的作业：别的教师布置、修改、删除、按编号查看 403，列表里看不到', async () => {
    const t2 = S.T2.token;
    fail(await req('POST', '/api/homeworks', { class_id: S.X.id, lesson_id: null, title: 't', content: 'c', due_date: day(3) }, { as: t2 }), 403);
    fail(await req('PATCH', `/api/homeworks/${ids.hw1}`, { title: 'x' }, { as: t2 }), 403);
    fail(await req('DELETE', `/api/homeworks/${ids.hw3}`, undefined, { as: t2 }), 403);
    fail(await req('GET', `/api/homeworks/${ids.hw1}`, undefined, { as: t2 }), 403);
    assert.ok(!(await list(`/api/homeworks?page_size=100`, t2)).some((h) => h.class_id === S.X.id));
  });
  await check('作业：sales 能读不能写 403，finance 不能用 403', async () => {
    const s = await fx.user('sales');
    ok(await req('GET', `/api/homeworks/${ids.hw1}`, undefined, { as: s.token }));
    fail(await req('POST', '/api/homeworks', { class_id: S.X.id, lesson_id: null, title: 't', content: 'c', due_date: day(3) }, { as: s.token }), 403);
    const f = await fx.user('finance');
    fail(await req('GET', '/api/homeworks', undefined, { as: f.token }), 403);
  });
  await check('PATCH 作业：class_id 忽略、标题可改；给了早于今天的 due_date 400', async () => {
    const h = await patch(`/api/homeworks/${ids.hw1}`, { class_id: S.Y.id, title: '口算练习（改）' }, S.T.token);
    assert.equal(h.class_id, S.X.id); assert.equal(h.title, '口算练习（改）');
    fail(await req('PATCH', `/api/homeworks/${ids.hw1}`, { due_date: day(-1) }), 400);
    assert.equal((await get(`/api/homeworks/${ids.hw1}`)).due_date, day(3));
  });
  await check('筹备中的班级不能布置作业 409；取消后的班级的作业不能修改 409、但能删除 204', async () => {
    fail(await req('POST', '/api/homeworks', { class_id: S.Z.id, lesson_id: null, title: 't', content: 'c', due_date: day(3) }), 409);
    const h = await post('/api/homeworks', { class_id: S.Y.id, lesson_id: null, title: 'Y 班作业', content: 'c', due_date: day(3) });
    ids.examY = (await post('/api/exams', { class_id: S.Y.id, name: 'Y 班测验', date: day(2), full_score: 100 })).id;
    await act(`/api/classes/${S.Y.id}/cancel`, { reason: '人数不足' });
    fail(await req('PATCH', `/api/homeworks/${h.id}`, { title: '改' }), 409);
    await del(`/api/homeworks/${h.id}`);
    fail(await req('GET', `/api/homeworks/${h.id}`), 404);
  });

  group('五期·作业提交与批改');
  await check('家长给自己的孩子提交作业：201，late false，score、comment、graded_by、graded_at 为 null，submitted_by 是家长；作业的 submitted_count 变为 1', async () => {
    const s = ok(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.A.id, content: ' 做完了 ' }, { as: S.P1.token }), 201);
    assert.equal(s.homework_id, ids.hw1); assert.equal(s.student_id, S.A.id); assert.equal(s.content, '做完了');
    assert.equal(s.late, false); assert.equal(s.score, null); assert.equal(s.comment, null); assert.equal(s.graded_by, null); assert.equal(s.graded_at, null);
    assert.equal(s.submitted_by, S.P1.user.id); assert.equal(typeof s.submitted_at, 'string');
    ids.subA = s.id;
    assert.equal((await get(`/api/homeworks/${ids.hw1}`)).submitted_count, 1);
  });
  await check('同一学员再提交 409；给别人的孩子提交 403；员工提交 403（只有 parent）', async () => {
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.A.id, content: '再交一次' }, { as: S.P3.token }), 409);
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.B.id, content: 'x' }, { as: S.P2.token }), 403);
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.B.id, content: 'x' }), 403);
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.B.id, content: 'x' }, { as: S.T.token }), 403);
  });
  await check('提交的学员不是这个班的当前学员（已退班）400；content 为空 400', async () => {
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.D.id, content: 'x' }, { as: S.P5.token }), 400);
    fail(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.B.id, content: '  ' }, { as: S.P1.token }), 400);
  });
  await check('没批改前提交人可以 PATCH content；同一孩子的另一位家长、教师 PATCH 403', async () => {
    assert.equal((await patch(`/api/submissions/${ids.subA}`, { content: '改过了' }, S.P1.token)).content, '改过了');
    fail(await req('PATCH', `/api/submissions/${ids.subA}`, { content: 'x' }, { as: S.P3.token }), 403);
    fail(await req('PATCH', `/api/submissions/${ids.subA}`, { content: 'x' }, { as: S.T.token }), 403);
  });
  await check('GET /api/submissions/:id：班级教师、这个学员的家长能看，别的家长 403', async () => {
    assert.equal((await get(`/api/submissions/${ids.subA}`, S.T.token)).content, '改过了');
    assert.equal((await get(`/api/submissions/${ids.subA}`, S.P3.token)).student_id, S.A.id);
    fail(await req('GET', `/api/submissions/${ids.subA}`, undefined, { as: S.P2.token }), 403);
  });
  await check('批改：score 不是 0–100 的整数、comment 超过 500 字 400；可以重复批改，以最后一次为准，填 graded_by、graded_at', async () => {
    const u = `/api/submissions/${ids.subA}/grade`;
    fail(await req('POST', u, { score: 101, comment: '' }, { as: S.T.token }), 400);
    fail(await req('POST', u, { score: 88.5, comment: '' }, { as: S.T.token }), 400);
    fail(await req('POST', u, { score: -1, comment: '' }, { as: S.T.token }), 400);
    fail(await req('POST', u, { score: 80, comment: 'x'.repeat(501) }, { as: S.T.token }), 400);
    assert.equal((await get(`/api/submissions/${ids.subA}`)).score, null, '失败的批改不应生效');
    await act(u, { score: 88, comment: '不错' }, S.T.token);
    const g = await act(u, { score: 92, comment: '很好' }, S.T.token);
    assert.equal(g.score, 92); assert.equal(g.comment, '很好'); assert.equal(g.graded_by, S.T.user.id); assert.equal(typeof g.graded_at, 'string');
    const again = await get(`/api/submissions/${ids.subA}`);
    assert.equal(again.score, 92); assert.equal(again.comment, '很好');
  });
  await check('批改权限：别的教师、sales 403；academic 可以批改', async () => {
    const s = await fx.user('sales');
    const ac = await fx.user('academic');
    const sub = ok(await req('POST', `/api/homeworks/${ids.hw2}/submissions`, { student_id: S.B.id, content: 'B 的预习' }, { as: S.P1.token }), 201);
    ids.subB2 = sub.id;
    fail(await req('POST', `/api/submissions/${sub.id}/grade`, { score: 70, comment: '' }, { as: S.T2.token }), 403);
    fail(await req('POST', `/api/submissions/${sub.id}/grade`, { score: 70, comment: '' }, { as: s.token }), 403);
    assert.equal((await act(`/api/submissions/${sub.id}/grade`, { score: 70, comment: '' }, ac.token)).score, 70);
  });
  await check('批改后提交人不能再改 content 409', async () => {
    fail(await req('PATCH', `/api/submissions/${ids.subA}`, { content: '再改' }, { as: S.P1.token }), 409);
    assert.equal((await get(`/api/submissions/${ids.subA}`)).content, '改过了');
  });
  await check('提交情况：班里每个当前学员加上提交后退班的学员各一项，按 student_id 升序，没提交的后四项为 null；没提交又退班的不列', async () => {
    const sg = ok(await req('POST', `/api/homeworks/${ids.hw1}/submissions`, { student_id: S.G.id, content: 'G 的作业' }, { as: S.P4.token }), 201);
    await del(`/api/classes/${S.X.id}/students/${S.G.id}`);
    const st = await get(`/api/homeworks/${ids.hw1}/status`);
    assert.deepEqual(pluck(st, 'student_id'), [S.A.id, S.B.id, S.C.id, S.E.id, S.G.id]);
    const a = st[0];
    assert.equal(a.name, S.A.name); assert.equal(a.no, S.A.no); assert.equal(a.submission_id, ids.subA);
    assert.equal(a.late, false); assert.equal(a.score, 92); assert.equal(typeof a.submitted_at, 'string');
    const b = st[1];
    assert.equal(b.submission_id, null); assert.equal(b.submitted_at, null); assert.equal(b.late, null); assert.equal(b.score, null);
    assert.equal(st[4].submission_id, sg.id);
    assert.equal((await get(`/api/homeworks/${ids.hw1}`)).student_count, 4, 'G 退班后当前在班 4 人');
  });
  await check('提交情况：家长只看到自己孩子的那一项', async () => {
    assert.deepEqual(pluck(await get(`/api/homeworks/${ids.hw1}/status`, S.P3.token), 'student_id'), [S.A.id]);
    assert.deepEqual(pluck(await get(`/api/homeworks/${ids.hw1}/status`, S.P2.token), 'student_id'), [S.C.id]);
    assert.deepEqual(pluck(await get(`/api/homeworks/${ids.hw1}/status`, S.P1.token), 'student_id'), [S.A.id, S.B.id]);
  });
  await check('有提交的作业不能删除 409；没有提交的可以删除 204', async () => {
    fail(await req('DELETE', `/api/homeworks/${ids.hw1}`, undefined, { as: S.T.token }), 409);
    assert.equal((await get(`/api/homeworks/${ids.hw1}`)).id, ids.hw1);
    const h = await post('/api/homeworks', { class_id: S.X.id, lesson_id: null, title: '临时', content: 'c', due_date: day(4) }, S.T.token);
    await del(`/api/homeworks/${h.id}`, S.T.token);
  });

  group('五期·考试与成绩');
  await check('新建考试：不给 pass_score 时是 ceil(full_score × 0.6)（7 → 5、12 → 8），给了用给的；带 class_name', async () => {
    const e = ok(await req('POST', '/api/exams', { class_id: S.X.id, name: '单元测验', date: day(-2), full_score: 7 }, { as: S.T.token }), 201);
    assert.equal(e.pass_score, 5); assert.equal(e.class_name, S.X.name); assert.equal(e.full_score, 7); assert.equal(typeof e.created_at, 'string');
    ids.ex2 = e.id;
    const e12 = await post('/api/exams', { class_id: S.X.id, name: '小测', date: day(-3), full_score: 12 });
    assert.equal(e12.pass_score, 8);
    ids.ex3 = e12.id;
    const e1 = await post('/api/exams', { class_id: S.X.id, name: '期中考试', date: day(-1), full_score: 100, pass_score: 60 });
    assert.equal(e1.pass_score, 60);
    ids.ex1 = e1.id;
    ids.exF = (await post('/api/exams', { class_id: S.X.id, name: '期末考试', date: day(3), full_score: 100 })).id;
  });
  await check('考试校验：pass_score 大于 full_score、full_score 为 0 400；筹备中的班级 409；别的教师新建与查看 403', async () => {
    const base = { class_id: S.X.id, name: 'x', date: day(1), full_score: 100 };
    fail(await req('POST', '/api/exams', { ...base, pass_score: 101 }), 400);
    fail(await req('POST', '/api/exams', { ...base, full_score: 0 }), 400);
    fail(await req('POST', '/api/exams', { ...base, class_id: S.Z.id }), 409);
    fail(await req('POST', '/api/exams', base, { as: S.T2.token }), 403);
    fail(await req('GET', `/api/exams/${ids.ex1}`, undefined, { as: S.T2.token }), 403);
  });
  await check('考试列表 class_id 筛选，按 date 降序', async () => {
    const items = await list(`/api/exams?class_id=${S.X.id}&page_size=100`);
    assert.deepEqual(pluck(items, 'id'), [ids.exF, ids.ex1, ids.ex2, ids.ex3]);
  });
  await check('考试名单是考试日期当天在班的学员：今天退班的学员在昨天的考试名单里，不在以后的考试名单里；按 student_id 升序', async () => {
    const r1 = await get(`/api/exams/${ids.ex1}/roster`);
    assert.deepEqual(pluck(r1, 'student_id'), [S.A.id, S.B.id, S.C.id, S.D.id, S.E.id, S.G.id]);
    assert.equal(r1[0].name, S.A.name); assert.equal(r1[0].no, S.A.no);
    assert.deepEqual(pluck(await get(`/api/exams/${ids.exF}/roster`), 'student_id'), [S.A.id, S.B.id, S.C.id, S.E.id]);
  });
  await check('录入成绩：返回排名列表；同分同名次（1、2、2、4），缺考 rank 为 null 排最后，同名次按 student_id 升序', async () => {
    const r = await put(`/api/exams/${ids.ex1}/scores`, { scores: [
      { student_id: S.E.id, score: null }, { student_id: S.C.id, score: 85.5 }, { student_id: S.D.id, score: 50.5 },
      { student_id: S.A.id, score: 90 }, { student_id: S.B.id, score: 85.5 },
    ] }, S.T.token);
    const want = [[S.A.id, 90, 1], [S.B.id, 85.5, 2], [S.C.id, 85.5, 2], [S.D.id, 50.5, 4], [S.E.id, null, null]];
    const shape = (rows) => rows.map((x) => [x.student_id, x.score === null ? null : Number(x.score), x.rank]);
    assert.deepEqual(shape(r), want);
    const g = await get(`/api/exams/${ids.ex1}/scores`);
    assert.deepEqual(shape(g), want, '没录入的 G 不出现');
    assert.equal(g[0].name, S.A.name);
  });
  await check('统计：count 是有分数的人数、absent 是缺考人数，avg 四舍五入一位小数，pass_rate 按 pass_score 四舍五入取整', async () => {
    // 90 + 85.5 + 85.5 + 50.5 = 311.5，/4 = 77.875 → 77.9；及格（≥60）3 人 / 4 = 75
    const s = await get(`/api/exams/${ids.ex1}/stats`);
    assert.equal(s.count, 4); assert.equal(s.absent, 1);
    assert.equal(Number(s.avg), 77.9); assert.equal(Number(s.max), 90); assert.equal(Number(s.min), 50.5); assert.equal(s.pass_rate, 75);
  });
  await check('统计：默认及格线 5（满分 7），及格 2/3 → 67；只录入部分学员时其余不计', async () => {
    await put(`/api/exams/${ids.ex2}/scores`, { scores: [{ student_id: S.A.id, score: 7 }, { student_id: S.B.id, score: 5 }, { student_id: S.C.id, score: 4.5 }] });
    // (7 + 5 + 4.5) / 3 = 5.5；≥5 的 2 人 / 3 = 66.67 → 67
    const s = await get(`/api/exams/${ids.ex2}/stats`);
    assert.equal(s.count, 3); assert.equal(s.absent, 0);
    assert.equal(Number(s.avg), 5.5); assert.equal(Number(s.max), 7); assert.equal(Number(s.min), 4.5); assert.equal(s.pass_rate, 67);
  });
  await check('没有成绩时统计 count 0、absent 0，avg、max、min、pass_rate 都是 null', async () => {
    assert.deepEqual(await get(`/api/exams/${ids.ex3}/stats`), { count: 0, absent: 0, avg: null, max: null, min: null, pass_rate: null });
    assert.deepEqual(await get(`/api/exams/${ids.ex3}/scores`), []);
  });
  await check('成绩校验：超过满分、负数、两位小数、学员重复、不是考试当天在班的学员 400，整次录入不生效', async () => {
    const u = `/api/exams/${ids.ex1}/scores`;
    const before = await get(u);
    const ok1 = { student_id: S.A.id, score: 60 };
    fail(await req('PUT', u, { scores: [ok1, { student_id: S.B.id, score: 100.5 }] }), 400);
    fail(await req('PUT', u, { scores: [ok1, { student_id: S.B.id, score: -1 }] }), 400);
    fail(await req('PUT', u, { scores: [ok1, { student_id: S.B.id, score: 85.55 }] }), 400);
    fail(await req('PUT', u, { scores: [ok1, { student_id: S.A.id, score: 70 }] }), 400);
    fail(await req('PUT', `/api/exams/${ids.exF}/scores`, { scores: [{ student_id: S.A.id, score: 60 }, { student_id: S.D.id, score: 60 }] }), 400);
    assert.deepEqual(await get(u), before);
    assert.deepEqual(await get(`/api/exams/${ids.exF}/scores`), []);
  });
  await check('PUT 成绩整体替换：再录一次只有 A，其他人的成绩没了', async () => {
    const r = await put(`/api/exams/${ids.ex2}/scores`, { scores: [{ student_id: S.A.id, score: 6 }] });
    assert.deepEqual(r.map((x) => [x.student_id, Number(x.score), x.rank]), [[S.A.id, 6, 1]]);
    assert.equal((await get(`/api/exams/${ids.ex2}/stats`)).count, 1);
  });
  await check('已录入成绩的考试不能改 date、full_score 409，可以改 name；不能删除 409；没成绩的考试可以删除 204', async () => {
    fail(await req('PATCH', `/api/exams/${ids.ex1}`, { date: day(-4) }), 409);
    fail(await req('PATCH', `/api/exams/${ids.ex1}`, { full_score: 120 }), 409);
    const e = await patch(`/api/exams/${ids.ex1}`, { name: '期中考试（数学）', class_id: S.Y.id });
    assert.equal(e.name, '期中考试（数学）'); assert.equal(e.class_id, S.X.id); assert.equal(e.date, day(-1)); assert.equal(e.full_score, 100);
    fail(await req('DELETE', `/api/exams/${ids.ex1}`), 409);
    await del(`/api/exams/${ids.ex3}`);
    fail(await req('GET', `/api/exams/${ids.ex3}`), 404);
  });
  await check('取消后的班级的考试不能修改 409', async () => {
    fail(await req('PATCH', `/api/exams/${ids.examY}`, { name: '改名' }), 409);
  });

  group('五期·课堂反馈');
  const fbUrl = () => `/api/lessons/${S.L(-1).id}/feedback`;
  await check('教师给已完成课次的出勤、迟到学员写反馈：返回列表按 student_id 升序，带 name、updated_at', async () => {
    const r = await put(fbUrl(), { items: [{ student_id: S.B.id, rating: 4, comment: '认真' }, { student_id: S.A.id, rating: 5, comment: ' 积极 ' }] }, S.T.token);
    assert.deepEqual(r.map((x) => [x.student_id, x.rating, x.comment]), [[S.A.id, 5, '积极'], [S.B.id, 4, '认真']]);
    assert.equal(r[0].name, S.A.name); assert.equal(typeof r[0].updated_at, 'string');
    assert.deepEqual(await get(fbUrl(), S.T.token), r);
  });
  await check('反馈学员必须点名为 present 或 late：absent、leave、不在名单的学员 400；rating 不是 1–5 的整数、comment 超过 300 字 400', async () => {
    const u = fbUrl();
    fail(await req('PUT', u, { items: [{ student_id: S.C.id, rating: 3, comment: '' }] }), 400);
    fail(await req('PUT', u, { items: [{ student_id: S.E.id, rating: 3, comment: '' }] }), 400);
    const other = await fx.student(S.campus.id);
    fail(await req('PUT', u, { items: [{ student_id: other.id, rating: 3, comment: '' }] }), 400);
    for (const rating of [0, 6, 4.5]) fail(await req('PUT', u, { items: [{ student_id: S.D.id, rating, comment: '' }] }), 400);
    fail(await req('PUT', u, { items: [{ student_id: S.D.id, rating: 3, comment: 'x'.repeat(301) }] }), 400);
  });
  await check('反馈：一个学员不合格时整个请求不生效；items 为空时 200，返回现有列表', async () => {
    const u = fbUrl();
    fail(await req('PUT', u, { items: [{ student_id: S.A.id, rating: 1, comment: '不该生效' }, { student_id: S.C.id, rating: 3, comment: '' }] }), 400);
    const r = await put(u, { items: [] });
    assert.deepEqual(r.map((x) => [x.student_id, x.rating, x.comment]), [[S.A.id, 5, '积极'], [S.B.id, 4, '认真']]);
  });
  await check('还没完成的课次不能写反馈 409（先于学员的校验）', async () => {
    fail(await req('PUT', `/api/lessons/${S.L(2).id}/feedback`, { items: [] }), 409);
    fail(await req('PUT', `/api/lessons/${S.L(2).id}/feedback`, { items: [{ student_id: S.C.id, rating: 3, comment: '' }] }), 409);
  });
  await check('反馈部分替换：请求里的学员被替换，没有的学员保持不变', async () => {
    const r = await put(fbUrl(), { items: [{ student_id: S.A.id, rating: 3, comment: '有点走神' }, { student_id: S.G.id, rating: 5, comment: '' }] });
    assert.deepEqual(r.map((x) => [x.student_id, x.rating, x.comment]), [[S.A.id, 3, '有点走神'], [S.B.id, 4, '认真'], [S.G.id, 5, '']]);
  });
  await check('反馈权限：别的教师写 403，sales 能读不能写 403，finance 读 403', async () => {
    fail(await req('PUT', fbUrl(), { items: [{ student_id: S.A.id, rating: 1, comment: '' }] }, { as: S.T2.token }), 403);
    const s = await fx.user('sales');
    assert.equal((await get(fbUrl(), s.token)).length, 3);
    fail(await req('PUT', fbUrl(), { items: [{ student_id: S.A.id, rating: 1, comment: '' }] }, { as: s.token }), 403);
    const f = await fx.user('finance');
    fail(await req('GET', fbUrl(), undefined, { as: f.token }), 403);
    assert.equal((await get(fbUrl())).find((x) => x.student_id === S.A.id).rating, 3);
  });

  group('五期·家长端');
  await check('家长端只有 parent 能用：admin、teacher 403', async () => {
    fail(await req('GET', '/api/parent/children'), 403);
    fail(await req('GET', '/api/parent/children', undefined, { as: S.T.token }), 403);
    fail(await req('GET', `/api/parent/schedule?from=${day(1)}&to=${day(4)}`, undefined, { as: S.T.token }), 403);
  });
  await check('children：每个绑定的孩子一项，按 id 升序；accounts 同课时账户接口、balance 同余额接口', async () => {
    const ch = await get('/api/parent/children', S.P1.token);
    assert.deepEqual(pluck(ch, 'id'), [S.A.id, S.B.id]);
    const a = ch[0];
    assert.equal(a.no, S.A.no); assert.equal(a.name, S.A.name); assert.equal(a.grade, S.A.grade); assert.equal(a.campus_name, S.campus.name);
    assert.deepEqual(a.accounts, await get(`/api/students/${S.A.id}/accounts`));
    assert.equal(a.accounts[0].remaining, 19, '买 20 节，day(-1) 出勤扣 1 节');
    assert.equal(a.balance, (await get(`/api/students/${S.A.id}/wallet`)).balance);
    assert.equal(a.balance, 0);
  });
  await check('schedule：两个孩子上同一节课时出现两次，按 date、start_time、student_id 升序；带 student_name 与这节课最近一条请假的编号、状态、审批意见', async () => {
    const lv = await post('/api/leaves', { student_id: S.A.id, lesson_id: S.L(3).id, reason: '看病' }, S.P1.token);
    ids.leaveP1 = lv.id;
    const ac = await fx.user('academic');
    await act(`/api/leaves/${lv.id}/reject`, { note: '考试周不批' }, ac.token);
    const r = await get(`/api/parent/schedule?from=${day(1)}&to=${day(4)}`, S.P1.token);
    const want = [];
    for (const n of [1, 2, 3, 4]) for (const s of [S.A, S.B]) want.push([S.L(n).id, s.id]);
    assert.deepEqual(r.map((x) => [x.id, x.student_id]), want);
    assert.equal(r[0].student_name, S.A.name); assert.equal(r[0].class_name, S.X.name); assert.equal(r[0].date, day(1));
    const a3 = r.find((x) => x.id === S.L(3).id && x.student_id === S.A.id);
    assert.equal(a3.leave_id, lv.id); assert.equal(a3.leave_status, 'rejected'); assert.equal(a3.leave_review_note, '考试周不批');
    const b3 = r.find((x) => x.id === S.L(3).id && x.student_id === S.B.id);
    assert.equal(b3.leave_id, null); assert.equal(b3.leave_status, null); assert.equal(b3.leave_review_note, null);
  });
  await check('schedule：student_id 只看这个孩子，不是自己的孩子看不到（403 或空数组）；不给 from、to 400', async () => {
    const r = await get(`/api/parent/schedule?from=${day(1)}&to=${day(4)}&student_id=${S.B.id}`, S.P1.token);
    assert.equal(r.length, 4); assert.ok(r.every((x) => x.student_id === S.B.id));
    // PRD 只规定路径里的 :id 不是自己的孩子 → 403；查询参数 student_id 按 REQ-004 AC2 也可以只返回范围内的记录（空数组）
    const other = await req('GET', `/api/parent/schedule?from=${day(1)}&to=${day(4)}&student_id=${S.C.id}`, undefined, { as: S.P1.token });
    if (other.status === 403) fail(other, 403); else assert.deepEqual(ok(other), [], `别人的孩子应 403 或空数组，实际 ${other.status} ${other.text.slice(0, 160)}`);
    fail(await req('GET', '/api/parent/schedule', undefined, { as: S.P1.token }), 400);
    fail(await req('GET', `/api/parent/schedule?from=${day(1)}&to=${day(40)}`, undefined, { as: S.P1.token }), 400);
  });
  await check('家长端考勤同学员考勤接口；不是自己的孩子 403', async () => {
    const r = await get(`/api/parent/students/${S.A.id}/attendance`, S.P1.token);
    assert.deepEqual(r, await get(`/api/students/${S.A.id}/attendance`));
    assert.ok(r.some((x) => x.lesson_id === S.L(-1).id && x.status === 'present'));
    for (const p of ['attendance', 'scores', 'feedback', 'homeworks']) {
      fail(await req('GET', `/api/parent/students/${S.C.id}/${p}`, undefined, { as: S.P1.token }), 403);
    }
  });
  await check('家长端成绩：每次有成绩记录（含缺考）的考试一项，按 date 降序；没有记录的考试不列', async () => {
    const a = await get(`/api/parent/students/${S.A.id}/scores`, S.P1.token);
    assert.deepEqual(a.map((x) => [x.exam_id, Number(x.score), x.rank]), [[ids.ex1, 90, 1], [ids.ex2, 6, 1]]);
    assert.equal(a[0].exam_name, '期中考试（数学）'); assert.equal(a[0].class_name, S.X.name); assert.equal(a[0].date, day(-1)); assert.equal(a[0].full_score, 100);
    const e = await get(`/api/parent/students/${S.E.id}/scores`, S.P4.token);
    assert.deepEqual(e.map((x) => [x.exam_id, x.score, x.rank]), [[ids.ex1, null, null]], 'E 缺考期中，单元测验没录入');
  });
  await check('家长端反馈：这个孩子的每条反馈 {lesson_id, date, class_name, rating, comment}', async () => {
    const r = await get(`/api/parent/students/${S.A.id}/feedback`, S.P1.token);
    assert.deepEqual(r.map((x) => [x.lesson_id, x.date, x.class_name, x.rating, x.comment]), [[S.L(-1).id, day(-1), S.X.name, 3, '有点走神']]);
    assert.deepEqual(await get(`/api/parent/students/${S.C.id}/feedback`, S.P2.token), []);
  });
  await check('家长端作业：孩子当前所在班级的作业，带这个孩子的 submission_id、late、score，没提交为 null', async () => {
    const r = await get(`/api/parent/students/${S.A.id}/homeworks`, S.P1.token);
    assert.deepEqual(pluck(r, 'id').sort((x, y) => x - y), [ids.hw1, ids.hw2, ids.hw3]);
    const h1 = r.find((x) => x.id === ids.hw1);
    assert.equal(h1.submission_id, ids.subA); assert.equal(h1.late, false); assert.equal(h1.score, 92); assert.equal(typeof h1.submitted_at, 'string');
    assert.equal(h1.class_name, S.X.name);
    const h2 = r.find((x) => x.id === ids.hw2);
    assert.equal(h2.submission_id, null); assert.equal(h2.submitted_at, null); assert.equal(h2.late, null); assert.equal(h2.score, null);
  });
  await check('家长也能通过学员详情、课时账户、学员考勤看自己的孩子（只读），别人的孩子 403', async () => {
    assert.equal((await get(`/api/students/${S.A.id}`, S.P1.token)).id, S.A.id);
    ok(await req('GET', `/api/students/${S.A.id}/accounts`, undefined, { as: S.P1.token }));
    ok(await req('GET', `/api/students/${S.A.id}/attendance/summary`, undefined, { as: S.P1.token }));
    fail(await req('GET', `/api/students/${S.C.id}`, undefined, { as: S.P1.token }), 403);
    fail(await req('PATCH', `/api/students/${S.A.id}`, { name: '改名' }, { as: S.P1.token }), 403);
  });

  group('五期·站内通知');
  const NOTE_KEYS = ['body', 'created_at', 'id', 'link', 'read', 'ref_id', 'ref_type', 'title', 'type'];
  await check('订单支付后这个学员的家长收到 order_paid：title 订单已支付、link /parent、ref 指向订单、未读', async () => {
    const ns = await notesOf(S.P1.token, 'order', S.orderA.id);
    assert.equal(ns.length, 1, JSON.stringify(ns));
    const n = ns[0];
    for (const k of NOTE_KEYS) assert.ok(k in n, `通知缺少字段 ${k}`);
    assert.equal(n.type, 'order_paid'); assert.equal(n.title, '订单已支付'); assert.equal(n.link, '/parent'); assert.equal(n.read, false);
    assert.ok(typeof n.body === 'string' && n.body.trim().length > 0);
    assert.equal((await notesOf(S.P1.token, 'order', S.orderB.id)).length, 1);
    assert.equal((await notesOf(S.P2.token, 'order', S.orderA.id)).length, 0, '别的家长不收');
  });
  await check('请假审批后创建人收到 leave_reviewed：家长的 link 是课次所在周周一的家长课表，员工的 link 是 /leaves', async () => {
    const ns = await notesOf(S.P1.token, 'leave', ids.leaveP1);
    assert.equal(ns.length, 1, JSON.stringify(ns));
    assert.equal(ns[0].type, 'leave_reviewed'); assert.equal(ns[0].title, '请假已审批');
    assert.equal(ns[0].link, `/parent/schedule?from=${mondayOf(day(3))}`);
    const sl = await fx.user('sales');
    const lv = await post('/api/leaves', { student_id: S.B.id, lesson_id: S.L(4).id, reason: '比赛' }, sl.token);
    await act(`/api/leaves/${lv.id}/approve`, {});
    const sn = await notesOf(sl.token, 'leave', lv.id);
    assert.equal(sn.length, 1, JSON.stringify(sn));
    assert.equal(sn[0].type, 'leave_reviewed'); assert.equal(sn[0].link, '/leaves');
    assert.equal((await notesOf(S.P1.token, 'leave', lv.id)).length, 0, '只发给请假的创建人，不发给家长');
  });
  await check('操作人自己不收：教务自己建的请假自己批准，不收到通知', async () => {
    const ac = await fx.user('academic');
    const lv = await post('/api/leaves', { student_id: S.A.id, lesson_id: S.L(4).id, reason: '回老家' }, ac.token);
    await act(`/api/leaves/${lv.id}/approve`, { note: '同意' }, ac.token);
    assert.equal((await notesOf(ac.token, 'leave', lv.id)).length, 0);
  });
  await check('作业批改后这个学员的全部家长收到 homework_graded（link /parent/homeworks），别的家长、批改的教师不收', async () => {
    for (const p of [S.P1, S.P3]) {
      const ns = await notesOf(p.token, 'submission', ids.subA);
      assert.equal(ns.length, 2, `批改了两次（88、92），每次给每位家长发一条：${JSON.stringify(ns)}`);
      for (const n of ns) { assert.equal(n.type, 'homework_graded'); assert.equal(n.title, '作业已批改'); assert.equal(n.link, '/parent/homeworks'); }
    }
    assert.equal((await notesOf(S.P1.token, 'submission', ids.subB2)).length, 1, 'B 的作业被教务批改，B 的家长 P1 收到');
    assert.equal((await notesOf(S.P2.token, 'submission', ids.subA)).length, 0);
    assert.equal((await notesOf(S.T.token, 'submission', ids.subA)).length, 0);
  });
  await check('代课后新旧教师（link /lessons/<id>）与应到学员的家长（link 课次所在周周一的家长课表）收到 lesson_changed；已退班学员的家长不收', async () => {
    const l5 = S.L(5);
    await act(`/api/lessons/${l5.id}/substitute`, { teacher_id: S.T2.teacher.id });
    for (const t of [S.T, S.T2]) {
      const ns = await notesOf(t.token, 'lesson', l5.id);
      assert.equal(ns.length, 1, JSON.stringify(ns));
      assert.equal(ns[0].type, 'lesson_changed'); assert.equal(ns[0].title, '课程变动'); assert.equal(ns[0].link, `/lessons/${l5.id}`);
    }
    for (const p of [S.P1, S.P2, S.P3, S.P4]) {
      const ns = await notesOf(p.token, 'lesson', l5.id);
      assert.equal(ns.length, 1, `每位家长一条（P1 的两个孩子 A、B 都上这节课也只发一条）：${JSON.stringify(ns)}`);
      for (const n of ns) { assert.equal(n.type, 'lesson_changed'); assert.equal(n.link, `/parent/schedule?from=${mondayOf(l5.date)}`); }
    }
    assert.equal((await notesOf(S.P5.token, 'lesson', l5.id)).length, 0, 'D 已退班，不是应到学员');
  });
  await check('停课后教师与家长收到 lesson_changed', async () => {
    const l6 = S.L(6);
    await act(`/api/lessons/${l6.id}/cancel`, { reason: '教师培训' });
    const tn = await notesOf(S.T.token, 'lesson', l6.id);
    assert.equal(tn.length, 1); assert.equal(tn[0].type, 'lesson_changed'); assert.equal(tn[0].link, `/lessons/${l6.id}`);
    const pn = await notesOf(S.P4.token, 'lesson', l6.id);
    assert.equal(pn.length, 1, JSON.stringify(pn)); assert.equal(pn[0].link, `/parent/schedule?from=${mondayOf(l6.date)}`);
  });
  await check('调课后教师与家长收到 lesson_changed，家长的 link 按调整后的日期所在周的周一', async () => {
    const l2 = S.L(2);
    const moved = await act(`/api/lessons/${l2.id}/reschedule`, { date: day(9), start_time: l2.start_time });
    assert.equal(moved.date, day(9));
    const tn = await notesOf(S.T.token, 'lesson', l2.id);
    assert.equal(tn.length, 1, JSON.stringify(tn)); assert.equal(tn[0].link, `/lessons/${l2.id}`);
    for (const p of [S.P1, S.P2]) {
      const pn = await notesOf(p.token, 'lesson', l2.id);
      assert.equal(pn.length, 1, JSON.stringify(pn));
      assert.equal(pn[0].type, 'lesson_changed'); assert.equal(pn[0].link, `/parent/schedule?from=${mondayOf(day(9))}`, `原日期 ${l2.date}，调到 ${day(9)}`);
    }
  });
  await check('退费审批后退费单的创建人收到 refund_reviewed（link /refunds/<id>），审批人不收', async () => {
    const h = await fx.student(S.campus.id);
    await fx.paidOrder(h.id, [{ course_id: S.course.id, lessons: 5 }]);
    const sr = await fx.user('sales');
    const fr = await fx.user('finance');
    const rf = await post('/api/refunds', { student_id: h.id, course_id: S.course.id, lessons: 1, to: 'original', reason: '搬家' }, sr.token);
    await act(`/api/refunds/${rf.id}/reject`, { reason: '合同未到期' }, fr.token);
    const ns = await notesOf(sr.token, 'refund', rf.id);
    assert.equal(ns.length, 1, JSON.stringify(ns));
    assert.equal(ns[0].type, 'refund_reviewed'); assert.equal(ns[0].title, '退费已审批'); assert.equal(ns[0].link, `/refunds/${rf.id}`);
    assert.equal((await notes(fr.token)).length, 0);
  });
  await check('通知列表只有自己的，按 id 降序；unread=true 只看未读；unread 不是 true/false 400', async () => {
    const all = await notes(S.P1.token);
    const nIds = pluck(all, 'id');
    assert.deepEqual(nIds, [...nIds].sort((x, y) => y - x));
    const tIds = new Set(pluck(await notes(S.T.token), 'id'));
    assert.ok(!nIds.some((id) => tIds.has(id)), '两个用户的通知不应有同一条');
    assert.ok((await notes(S.P1.token, '&unread=true')).every((n) => n.read === false));
    fail(await req('GET', '/api/notifications?unread=yes', undefined, { as: S.P1.token }), 400);
    const p1 = await get('/api/notifications?page_size=1&page=2', S.P1.token);
    assert.equal(p1.total, all.length); assert.equal(p1.page, 2); assert.equal(p1.page_size, 1);
    assert.deepEqual(pluck(p1.items, 'id'), [all[1].id], '分页：第 2 页每页 1 条是第二新的一条');
  });
  await check('未读数；标记一条已读 204 后未读数减 1；别人的通知 404；全部已读 204 后未读数为 0', async () => {
    const c0 = (await get('/api/notifications/unread-count', S.P1.token)).count;
    const unread = await notes(S.P1.token, '&unread=true');
    assert.equal(c0, unread.length); assert.ok(c0 >= 2);
    const target = unread[0];
    assert.equal((await req('POST', `/api/notifications/${target.id}/read`, undefined, { as: S.P1.token })).status, 204);
    assert.equal((await get('/api/notifications/unread-count', S.P1.token)).count, c0 - 1);
    assert.equal((await notes(S.P1.token)).find((n) => n.id === target.id).read, true);
    fail(await req('POST', `/api/notifications/${unread[1].id}/read`, undefined, { as: S.P2.token }), 404);
    assert.equal((await get('/api/notifications/unread-count', S.P1.token)).count, c0 - 1, '别人标记不影响');
    assert.equal((await req('POST', '/api/notifications/read-all', undefined, { as: S.P1.token })).status, 204);
    assert.equal((await get('/api/notifications/unread-count', S.P1.token)).count, 0);
    assert.ok((await notes(S.P1.token)).every((n) => n.read === true));
  });

  group('五期·公告');
  const A = {};
  await check('教务新建公告：pinned 默认 false、published_at 为 null，created_by 是自己；sales 新建 403，teacher 查看管理列表 403', async () => {
    const ac = await fx.user('academic');
    A.ac = ac;
    const a = ok(await req('POST', '/api/announcements', { title: ' 放假通知 ', content: '国庆放假', audience: 'all', campus_id: null }, { as: ac.token }), 201);
    assert.equal(a.title, '放假通知'); assert.equal(a.pinned, false); assert.equal(a.published_at, null); assert.equal(a.created_by, ac.user.id);
    assert.equal(a.audience, 'all'); assert.equal(a.campus_id, null); assert.equal(typeof a.created_at, 'string');
    A.draft = a.id;
    const s = await fx.user('sales');
    fail(await req('POST', '/api/announcements', { title: 't', content: 'c', audience: 'all', campus_id: null }, { as: s.token }), 403);
    fail(await req('GET', '/api/announcements', undefined, { as: S.T.token }), 403);
  });
  await check('公告校验：audience 不对、标题为空、内容超过 5000 字 400', async () => {
    const base = { title: 't', content: 'c', audience: 'all', campus_id: null };
    fail(await req('POST', '/api/announcements', { ...base, audience: 'teachers' }), 400);
    fail(await req('POST', '/api/announcements', { ...base, title: ' ' }), 400);
    fail(await req('POST', '/api/announcements', { ...base, content: 'x'.repeat(5001) }), 400);
  });
  await check('发布填 published_at，已发布的再发布 409；没发布的可以改任何字段', async () => {
    const a = await post('/api/announcements', { title: '草稿', content: 'c', audience: 'staff', campus_id: null });
    assert.equal((await patch(`/api/announcements/${a.id}`, { title: '草稿改' })).title, '草稿改');
    const p = await act(`/api/announcements/${a.id}/publish`);
    assert.equal(typeof p.published_at, 'string');
    fail(await req('POST', `/api/announcements/${a.id}/publish`), 409);
    A.pub = a.id;
  });
  await check('已发布的公告只能改 pinned：改标题 409（不生效），改 pinned 200；可以删除 204', async () => {
    fail(await req('PATCH', `/api/announcements/${A.pub}`, { title: '新标题' }), 409);
    const p = await patch(`/api/announcements/${A.pub}`, { pinned: true });
    assert.equal(p.pinned, true); assert.equal(p.title, '草稿改');
    await del(`/api/announcements/${A.pub}`);
    assert.ok(!(await list('/api/announcements?page_size=100')).some((x) => x.id === A.pub));
  });
  await check('可见公告按受众与校区过滤：家长看 all/parents 且全校或孩子所在校区的；未发布的谁都看不到', async () => {
    const c2 = await fx.campus(); const c3 = await fx.campus();
    A.c2 = c2; A.c3 = c3;
    const mk = async (audience, campusId) => (await post('/api/announcements', { title: `${audience}-${campusId}`, content: 'c', audience, campus_id: campusId })).id;
    A.a1 = await mk('parents', c2.id); A.a2 = await mk('staff', null); A.a3 = await mk('all', c3.id); A.a5 = await mk('all', null); A.a6 = await mk('parents', c3.id);
    for (const id of [A.a1, A.a5, A.a6]) await act(`/api/announcements/${id}/publish`);
    await sleep(1100);
    await act(`/api/announcements/${A.a2}/publish`);
    await sleep(1100);
    await act(`/api/announcements/${A.a3}/publish`);
    await patch(`/api/announcements/${A.a5}`, { pinned: true });
    const kid = await fx.student(c2.id);
    A.px = await fx.parentOf([kid.id]);
    const mine = new Set([A.a1, A.a2, A.a3, A.a5, A.a6, A.draft]);
    const seen = (await get('/api/announcements/visible', A.px.token)).filter((x) => mine.has(x.id));
    assert.deepEqual(pluck(seen, 'id').sort((x, y) => x - y), [A.a1, A.a5].sort((x, y) => x - y));
  });
  await check('可见公告：教师看 all/staff 且全校或自己档案校区的；其他员工看全部校区的；每项带 campus_name', async () => {
    const tx = await fx.teacher(A.c3.id, [S.sch.subject.id]);
    const mine = new Set([A.a1, A.a2, A.a3, A.a5, A.a6, A.draft]);
    const tSeen = (await get('/api/announcements/visible', tx.token)).filter((x) => mine.has(x.id));
    assert.deepEqual(pluck(tSeen, 'id').sort((x, y) => x - y), [A.a2, A.a3, A.a5].sort((x, y) => x - y));
    const ty = await fx.teacher(A.c2.id, [S.sch.subject.id]);
    const tySeen = (await get('/api/announcements/visible', ty.token)).filter((x) => mine.has(x.id));
    assert.deepEqual(pluck(tySeen, 'id').sort((x, y) => x - y), [A.a2, A.a5].sort((x, y) => x - y));
    const f = await fx.user('finance');
    const fSeen = (await get('/api/announcements/visible', f.token)).filter((x) => mine.has(x.id));
    assert.deepEqual(pluck(fSeen, 'id'), [A.a5, A.a3, A.a2], 'pinned 在前，再按 published_at 降序');
    assert.equal(fSeen[1].campus_name, A.c3.name); assert.equal(fSeen[2].campus_name, null);
  });
  await check('可见公告排序：所有 pinned 的在前，同组内按 published_at 降序', async () => {
    const v = await get('/api/announcements/visible', A.ac.token);
    const firstUnpinned = v.findIndex((x) => !x.pinned);
    if (firstUnpinned >= 0) assert.ok(v.slice(firstUnpinned).every((x) => !x.pinned), 'pinned 的应全部排在前面');
    for (const grp of [v.filter((x) => x.pinned), v.filter((x) => !x.pinned)]) {
      for (let i = 1; i < grp.length; i++) assert.ok(Date.parse(grp[i - 1].published_at) >= Date.parse(grp[i].published_at), 'published_at 应降序');
    }
    assert.ok(v.every((x) => x.published_at !== null));
  });
  await check('管理列表返回全部（含未发布的），按 id 降序', async () => {
    const items = await list('/api/announcements?page_size=100', A.ac.token);
    const mine = new Set([A.a1, A.a2, A.a3, A.a5, A.a6, A.draft]);
    assert.deepEqual(pluck(items.filter((x) => mine.has(x.id)), 'id'), [A.a6, A.a5, A.a3, A.a2, A.a1, A.draft]);
    assert.equal(items.find((x) => x.id === A.draft).published_at, null);
  });
}
