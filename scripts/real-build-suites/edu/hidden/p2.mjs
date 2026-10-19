// 第二期：学员、家长绑定、线索、跟进、试听、转化、优惠、订单与收据、课时包与账户（REQ-012–REQ-020）。
// 扣课时（REQ-020 AC2）要点名，留给 p3；这里只测购买生成的课时包、账户与流水。
import { act, assert, check, day, del, fail, fx, get, group, list, ok, patch, pluck, post, req } from './lib.mjs';

// 手机号：本文件内唯一（177 开头 + 本次运行的 5 位 + 3 位序号）
const RUN = String(Date.now()).slice(-5);
let phoneSeq = 0;
const phone = () => `177${RUN}${String(++phoneSeq).padStart(3, '0')}`;
let k = 0;
const tag = (s) => `p2${RUN}-${s}-${++k}`;
const isDesc = (ids) => ids.every((x, i) => i === 0 || ids[i - 1] > x);

export async function run() {
  const S = await fx.school(); // 课程每节 10000 分
  const C2 = await fx.campus(); // 学员列表筛选专用
  const off = await fx.campus();
  await patch(`/api/campuses/${off.id}`, { active: false });
  const admin = await get('/api/auth/me');
  const s1 = await fx.user('sales');
  const s2 = await fx.user('sales');
  const lead = (extra = {}, as) => post('/api/leads', { name: tag('线索'), phone: phone(), grade: 4, source: 'walk_in', interest_course_id: S.course.id, campus_id: S.campus.id, ...extra }, as);
  const followUp = (leadId, extra = {}, as) => post(`/api/leads/${leadId}/follow-ups`, { method: 'phone', content: '电话沟通', next_follow_up: null, ...extra }, as);
  const trial = (leadId, extra = {}, as) => post('/api/trials', { lead_id: leadId, course_id: S.course.id, campus_id: S.campus.id, teacher_id: S.teacher.id, date: day(3), start_time: '10:00', ...extra }, as);
  /** 跟进 → 约试听 → 到课，返回状态为 trialed 的线索 */
  async function trialedLead(extra = {}, as) {
    const l = await lead(extra, as);
    await followUp(l.id, {}, as);
    const t = await trial(l.id, {}, as);
    await req('POST', `/api/trials/${t.id}/complete`, { attended: true, feedback: '' }, { as });
    return get(`/api/leads/${l.id}`, as);
  }
  const order = (studentId, items, extra = {}, as) => post('/api/orders', { student_id: studentId, items, discount_id: null, note: '', ...extra }, as);
  const discount = (extra = {}, as) => post('/api/discounts', { name: tag('优惠'), type: 'amount', value: 1000, ...extra }, as);

  group('二期·学员');
  await check('创建学员：学号 S+6 位且递增，默认 gender unknown、school ""、phone ""、status active、note ""，带 campus_name', async () => {
    const a = await post('/api/students', { name: ' 张小明 ', campus_id: S.campus.id });
    const b = await post('/api/students', { name: '李小红', campus_id: S.campus.id, grade: null, birth_date: day(0) });
    assert.match(a.no, /^S\d{6}$/); assert.match(b.no, /^S\d{6}$/);
    assert.ok(Number(b.no.slice(1)) > Number(a.no.slice(1)), `学号应递增：${a.no} ${b.no}`);
    assert.equal(a.name, '张小明'); assert.equal(a.gender, 'unknown'); assert.equal(a.school, ''); assert.equal(a.phone, '');
    assert.equal(a.status, 'active'); assert.equal(a.note, ''); assert.equal(a.campus_id, S.campus.id); assert.equal(a.campus_name, S.campus.name);
    assert.equal(typeof a.created_at, 'string');
    assert.equal(b.birth_date, day(0)); assert.equal(b.grade, null);
  });
  await check('学员校验：姓名为空、gender 取值、出生日期晚于今天或不存在、年级越界、手机号格式、校区缺失/不存在/停用都是 400', async () => {
    const base = { name: '学员', campus_id: S.campus.id };
    for (const bad of [{ name: '  ' }, { name: 'x'.repeat(31) }, { gender: 'boy' }, { birth_date: day(1) }, { birth_date: '2015-02-30' }, { grade: 0 }, { grade: 13 },
      { phone: '138abc' }, { school: 'x'.repeat(51) }, { note: 'x'.repeat(501) }, { campus_id: undefined }, { campus_id: 99999 }, { campus_id: off.id }]) {
      fail(await req('POST', '/api/students', { ...base, ...bad }), 400);
    }
  });
  await check('学员列表：按 id 降序；q 匹配姓名、学号、手机号；campus_id、grade、status 筛选；status 取值不对 400', async () => {
    const p = phone();
    const a = await post('/api/students', { name: tag('甲'), campus_id: C2.id, grade: 11 });
    const b = await post('/api/students', { name: tag('乙'), campus_id: C2.id, grade: 3, phone: p });
    const c = await post('/api/students', { name: tag('丙'), campus_id: C2.id, grade: 11 });
    await patch(`/api/students/${c.id}`, { status: 'inactive' });
    const all = await list(`/api/students?campus_id=${C2.id}&page_size=100`);
    assert.deepEqual(pluck(all, 'id'), [c.id, b.id, a.id]);
    assert.deepEqual(pluck(await list(`/api/students?campus_id=${C2.id}&grade=11`), 'id'), [c.id, a.id]);
    assert.deepEqual(pluck(await list(`/api/students?campus_id=${C2.id}&status=active`), 'id'), [b.id, a.id]);
    assert.deepEqual(pluck(await list(`/api/students?q=${encodeURIComponent(a.name)}`), 'id'), [a.id]);
    assert.deepEqual(pluck(await list(`/api/students?q=${b.no}`), 'id'), [b.id]);
    assert.deepEqual(pluck(await list(`/api/students?q=${p}`), 'id'), [b.id]);
    fail(await req('GET', '/api/students?status=gone'), 400);
  });
  await check('学员详情带 guardians（没有时 []）；PATCH 可以改 status，取值不对 400', async () => {
    const s = await fx.student(S.campus.id);
    const d = await get(`/api/students/${s.id}`);
    assert.deepEqual(d.guardians, []); assert.equal(d.no, s.no);
    assert.equal((await patch(`/api/students/${s.id}`, { status: 'inactive', school: '实验小学' })).status, 'inactive');
    assert.equal((await get(`/api/students/${s.id}`)).school, '实验小学');
    fail(await req('PATCH', `/api/students/${s.id}`, { status: 'paused' }), 400);
    fail(await req('PATCH', `/api/students/${s.id}`, { birth_date: day(1) }), 400);
  });
  await check('删除学员：没有记录的 204 之后 404；有订单（待支付也算）的 409；停读的学员不能下单 409', async () => {
    const free = await fx.student(S.campus.id);
    await del(`/api/students/${free.id}`);
    fail(await req('GET', `/api/students/${free.id}`), 404);
    const withOrder = await fx.student(S.campus.id);
    await order(withOrder.id, [{ course_id: S.course.id, lessons: 1 }]);
    fail(await req('DELETE', `/api/students/${withOrder.id}`), 409);
    const inactive = await fx.student(S.campus.id);
    await patch(`/api/students/${inactive.id}`, { status: 'inactive' });
    fail(await req('POST', '/api/orders', { student_id: inactive.id, items: [{ course_id: S.course.id, lessons: 1 }], discount_id: null, note: '' }), 409);
  });
  await check('学员列表 class_id 只返回当前在这个班的学员；教师只能看到自己班里的学员（列表与按编号，别的 403）', async () => {
    const inClass = await fx.student(S.campus.id);
    const outside = await fx.student(S.campus.id);
    await fx.paidOrder(inClass.id, [{ course_id: S.course.id, lessons: 5 }]);
    const { cls } = await fx.publishedClass({ course: S.course, campusId: S.campus.id, roomId: S.room.id, teacherId: S.teacher.id, startDate: day(1), lessonCount: 2 });
    await fx.enroll(cls.id, inClass.id);
    assert.deepEqual(pluck(await list(`/api/students?class_id=${cls.id}`), 'id'), [inClass.id]);
    const seen = await list('/api/students?page_size=100', S.teacherToken);
    assert.ok(seen.some((s) => s.id === inClass.id), '教师应能看到自己班里的学员');
    assert.ok(!seen.some((s) => s.id === outside.id), '教师不应看到别的学员');
    ok(await req('GET', `/api/students/${inClass.id}`, undefined, { as: S.teacherToken }));
    fail(await req('GET', `/api/students/${outside.id}`, undefined, { as: S.teacherToken }), 403);
  });
  await check('权限：finance 能读学员不能建 403；没有绑定教师档案的 teacher 列表为空、按编号 403', async () => {
    const s = await fx.student(S.campus.id);
    const f = await fx.user('finance');
    ok(await req('GET', `/api/students/${s.id}`, undefined, { as: f.token }));
    fail(await req('POST', '/api/students', { name: 'x', campus_id: S.campus.id }, { as: f.token }), 403);
    fail(await req('PATCH', `/api/students/${s.id}`, { name: 'x' }, { as: f.token }), 403);
    const t = await fx.user('teacher');
    assert.deepEqual(await list('/api/students', t.token), []);
    fail(await req('GET', `/api/students/${s.id}`, undefined, { as: t.token }), 403);
  });

  group('二期·家长绑定');
  await check('绑定返回 201 与这一条（name、phone 取家长用户的）；列表按 user_id 升序；学员详情的 guardians 相同', async () => {
    const s = await fx.student(S.campus.id);
    const pa = await fx.user('parent', { phone: '139 0000 0001' });
    const pb = await fx.user('parent');
    const rb = await post(`/api/students/${s.id}/guardians`, { user_id: pb.user.id, relation: 'father' });
    const pick = (x) => ({ user_id: x.user_id, name: x.name, phone: x.phone, relation: x.relation });
    assert.deepEqual(pick(rb), { user_id: pb.user.id, name: pb.user.name, phone: '', relation: 'father' });
    await post(`/api/students/${s.id}/guardians`, { user_id: pa.user.id, relation: 'mother' });
    const g = await get(`/api/students/${s.id}/guardians`);
    assert.deepEqual(g.map(pick), [{ user_id: pa.user.id, name: pa.user.name, phone: '139 0000 0001', relation: 'mother' }, pick(rb)]);
    assert.deepEqual((await get(`/api/students/${s.id}`)).guardians.map(pick), g.map(pick));
  });
  await check('绑定校验：用户不存在、不是 parent、已停用、relation 取值不对 400；重复绑定 409', async () => {
    const s = await fx.student(S.campus.id);
    const p = await fx.user('parent');
    const stopped = await fx.user('parent');
    await patch(`/api/users/${stopped.user.id}`, { active: false });
    const u = `/api/students/${s.id}/guardians`;
    fail(await req('POST', u, { user_id: 99999, relation: 'mother' }), 400);
    fail(await req('POST', u, { user_id: s1.user.id, relation: 'mother' }), 400);
    fail(await req('POST', u, { user_id: stopped.user.id, relation: 'mother' }), 400);
    fail(await req('POST', u, { user_id: p.user.id, relation: 'uncle' }), 400);
    await post(u, { user_id: p.user.id, relation: 'other' });
    fail(await req('POST', u, { user_id: p.user.id, relation: 'mother' }), 409);
    assert.equal((await get(u)).length, 1);
  });
  await check('一个学员最多 4 个家长，第 5 个 409', async () => {
    const s = await fx.student(S.campus.id);
    for (let i = 0; i < 4; i++) await fx.parentOf([s.id], 'other');
    const p5 = await fx.user('parent');
    fail(await req('POST', `/api/students/${s.id}/guardians`, { user_id: p5.user.id, relation: 'other' }), 409);
    assert.equal((await get(`/api/students/${s.id}/guardians`)).length, 4);
  });
  await check('家长绑定多个学员：me.student_ids 升序；只能看到自己的孩子（列表只有自己的，别人的 403）', async () => {
    const a = await fx.student(S.campus.id);
    const b = await fx.student(S.campus.id);
    const other = await fx.student(S.campus.id);
    const p = await fx.parentOf([b.id, a.id]);
    assert.deepEqual((await get('/api/auth/me', p.token)).student_ids, [a.id, b.id]);
    ok(await req('GET', `/api/students/${a.id}`, undefined, { as: p.token }));
    fail(await req('GET', `/api/students/${other.id}`, undefined, { as: p.token }), 403);
    assert.deepEqual(pluck(await list('/api/students?page_size=100', p.token), 'id').sort((x, y) => x - y), [a.id, b.id]);
  });
  await check('解绑 204：家长立即看不到这个学员（详情、课时包 403），me.student_ids 不再包含；再解绑 404', async () => {
    const a = await fx.student(S.campus.id);
    const b = await fx.student(S.campus.id);
    const p = await fx.parentOf([a.id, b.id]);
    ok(await req('GET', `/api/students/${a.id}/packages`, undefined, { as: p.token }));
    await del(`/api/students/${a.id}/guardians/${p.user.id}`);
    fail(await req('GET', `/api/students/${a.id}`, undefined, { as: p.token }), 403);
    fail(await req('GET', `/api/students/${a.id}/packages`, undefined, { as: p.token }), 403);
    assert.deepEqual((await get('/api/auth/me', p.token)).student_ids, [b.id]);
    fail(await req('DELETE', `/api/students/${a.id}/guardians/${p.user.id}`), 404);
  });
  await check('绑定了学员的家长用户不能删除、不能改角色 409', async () => {
    const s = await fx.student(S.campus.id);
    const p = await fx.parentOf([s.id]);
    fail(await req('DELETE', `/api/users/${p.user.id}`), 409);
    fail(await req('PATCH', `/api/users/${p.user.id}`, { role: 'sales' }), 409);
  });
  await check('权限：sales 能绑定；finance、parent 绑定 403', async () => {
    const s = await fx.student(S.campus.id);
    const p = await fx.user('parent');
    const f = await fx.user('finance');
    fail(await req('POST', `/api/students/${s.id}/guardians`, { user_id: p.user.id, relation: 'mother' }, { as: f.token }), 403);
    ok(await req('POST', `/api/students/${s.id}/guardians`, { user_id: p.user.id, relation: 'mother' }, { as: s1.token }), 201);
    const p2 = await fx.user('parent');
    fail(await req('POST', `/api/students/${s.id}/guardians`, { user_id: p2.user.id, relation: 'father' }, { as: p.token }), 403);
  });

  group('二期·线索');
  await check('创建线索：status new，student_id、next_follow_up 为 null，lost_reason、note 为 ""；不给 owner_id 时是创建人，带 owner_name', async () => {
    const l = await lead();
    assert.equal(l.status, 'new'); assert.equal(l.student_id, null); assert.equal(l.next_follow_up, null);
    assert.equal(l.lost_reason, ''); assert.equal(l.note, '');
    assert.equal(l.owner_id, admin.id); assert.equal(l.owner_name, admin.name);
    assert.equal(typeof l.created_at, 'string');
  });
  await check('owner_id：admin 可指定启用的 sales；不是 sales/admin、已停用、不存在 400；sales 创建时给的 owner_id 忽略', async () => {
    assert.equal((await lead({ owner_id: s1.user.id })).owner_id, s1.user.id);
    const f = await fx.user('finance');
    const stopped = await fx.user('sales');
    await patch(`/api/users/${stopped.user.id}`, { active: false });
    for (const owner_id of [f.user.id, stopped.user.id, 99999]) fail(await req('POST', '/api/leads', { name: 'x', phone: phone(), source: 'online', campus_id: S.campus.id, owner_id }), 400);
    const mine = await lead({ owner_id: s2.user.id }, s1.token);
    assert.equal(mine.owner_id, s1.user.id); assert.equal(mine.owner_name, s1.user.name);
  });
  await check('线索校验：手机号缺失、少于 5 或超过 20 个字符、有非法字符，source 取值，年级越界，校区停用，姓名为空都是 400', async () => {
    const base = { name: '线索', phone: phone(), source: 'event', campus_id: S.campus.id };
    for (const bad of [{ phone: undefined }, { phone: '1234' }, { phone: '1'.repeat(21) }, { phone: '1380000abcd' }, { source: 'tv' }, { grade: 13 }, { campus_id: off.id }, { name: ' ' }, { interest_course_id: 99999 }]) {
      fail(await req('POST', '/api/leads', { ...base, ...bad }), 400);
    }
  });
  await check('同一手机号（去掉空格、-、+ 后）只能有一条没结束的线索 409（创建与 PATCH）；流失后可以再建', async () => {
    const digits = phone();
    const a = await lead({ phone: `+86 ${digits.slice(0, 3)}-${digits.slice(3)}` });
    fail(await req('POST', '/api/leads', { name: '重复', phone: `86${digits}`, source: 'online', campus_id: S.campus.id }), 409);
    const b = await lead();
    fail(await req('PATCH', `/api/leads/${b.id}`, { phone: `86 ${digits}` }), 409);
    await req('POST', `/api/leads/${a.id}/lose`, { reason: '不需要' });
    ok(await req('POST', '/api/leads', { name: '再来', phone: `86-${digits}`, source: 'online', campus_id: S.campus.id }), 201);
  });
  await check('PATCH 线索：status 忽略；sales 给的 owner_id 忽略；已结束的线索不能 PATCH 409', async () => {
    const l = await lead({}, s1.token);
    const r = await patch(`/api/leads/${l.id}`, { name: '改名了', status: 'trialed', owner_id: s2.user.id, note: '家长想周末上' }, s1.token);
    assert.equal(r.name, '改名了'); assert.equal(r.status, 'new'); assert.equal(r.owner_id, s1.user.id); assert.equal(r.note, '家长想周末上');
    await req('POST', `/api/leads/${l.id}/lose`, { reason: '太远' }, { as: s1.token });
    fail(await req('PATCH', `/api/leads/${l.id}`, { name: '再改' }, { as: s1.token }), 409);
  });
  await check('流失：reason 为空或超过 200 字 400；→ lost 并记 lost_reason；已结束的再流失 409', async () => {
    const l = await lead();
    fail(await req('POST', `/api/leads/${l.id}/lose`, { reason: ' ' }), 400);
    fail(await req('POST', `/api/leads/${l.id}/lose`, { reason: 'x'.repeat(201) }), 400);
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'new');
    const r = ok(await req('POST', `/api/leads/${l.id}/lose`, { reason: '价格太高' }));
    assert.equal(r.status, 'lost'); assert.equal(r.lost_reason, '价格太高');
    fail(await req('POST', `/api/leads/${l.id}/lose`, { reason: '又一次' }), 409);
  });
  await check('删除线索：没有跟进与试听的 204；有跟进记录的 409', async () => {
    const a = await lead();
    await del(`/api/leads/${a.id}`);
    fail(await req('GET', `/api/leads/${a.id}`), 404);
    const b = await lead();
    await followUp(b.id);
    fail(await req('DELETE', `/api/leads/${b.id}`), 409);
  });
  await check('线索列表：按 id 降序；status、source、campus_id、owner_id、q（姓名或手机号）、follow_up_before 筛选', async () => {
    const camp = await fx.campus();
    const p = phone();
    const a = await lead({ campus_id: camp.id, source: 'referral', owner_id: s2.user.id });
    const b = await lead({ campus_id: camp.id, source: 'online', phone: p });
    const c = await lead({ campus_id: camp.id, source: 'online' });
    await followUp(a.id, { next_follow_up: day(3) });
    await followUp(b.id, { next_follow_up: day(10) });
    const u = `/api/leads?campus_id=${camp.id}`;
    assert.deepEqual(pluck(await list(u), 'id'), [c.id, b.id, a.id]);
    assert.deepEqual(pluck(await list(`${u}&status=contacted`), 'id'), [b.id, a.id]);
    assert.deepEqual(pluck(await list(`${u}&source=online`), 'id'), [c.id, b.id]);
    assert.deepEqual(pluck(await list(`${u}&owner_id=${s2.user.id}`), 'id'), [a.id]);
    assert.deepEqual(pluck(await list(`/api/leads?q=${p}`), 'id'), [b.id]);
    assert.deepEqual(pluck(await list(`/api/leads?q=${encodeURIComponent(c.name)}`), 'id'), [c.id]);
    assert.deepEqual(pluck(await list(`${u}&follow_up_before=${day(5)}`), 'id'), [a.id]);
    fail(await req('GET', '/api/leads?status=hot'), 400);
  });
  await check('sales 只看到自己负责的线索：列表（owner_id 参数无效）只有自己的，别人的线索读、改、流失 403', async () => {
    const mine = await lead({}, s1.token);
    const theirs = await lead({}, s2.token);
    const seen = await list(`/api/leads?owner_id=${s2.user.id}&page_size=100`, s1.token);
    assert.ok(seen.length > 0 && seen.every((l) => l.owner_id === s1.user.id), 'sales 只应看到自己的线索');
    assert.ok(seen.some((l) => l.id === mine.id));
    fail(await req('GET', `/api/leads/${theirs.id}`, undefined, { as: s1.token }), 403);
    fail(await req('PATCH', `/api/leads/${theirs.id}`, { name: 'x' }, { as: s1.token }), 403);
    fail(await req('POST', `/api/leads/${theirs.id}/lose`, { reason: 'x' }, { as: s1.token }), 403);
    assert.equal((await get(`/api/leads/${theirs.id}`)).status, 'new');
  });
  await check('权限：academic、finance 不能用线索 403', async () => {
    const l = await lead();
    for (const role of ['academic', 'finance']) {
      const u = await fx.user(role);
      fail(await req('GET', '/api/leads', undefined, { as: u.token }), 403);
      fail(await req('GET', `/api/leads/${l.id}`, undefined, { as: u.token }), 403);
    }
  });

  group('二期·跟进记录');
  await check('添加跟进：返回 201 与完整字段（含 created_by_name）；线索 new → contacted，next_follow_up 改成这一条的', async () => {
    const l = await lead({}, s1.token);
    const f = await followUp(l.id, { method: 'wechat', content: ' 发了课程介绍 ', next_follow_up: day(2) }, s1.token);
    assert.equal(typeof f.id, 'number'); assert.equal(typeof f.created_at, 'string');
    assert.equal(f.lead_id, l.id); assert.equal(f.method, 'wechat'); assert.equal(f.content, '发了课程介绍'); assert.equal(f.next_follow_up, day(2));
    assert.equal(f.created_by, s1.user.id); assert.equal(f.created_by_name, s1.user.name);
    const r = await get(`/api/leads/${l.id}`, s1.token);
    assert.equal(r.status, 'contacted'); assert.equal(r.next_follow_up, day(2));
  });
  await check('跟进校验：next_follow_up 早于今天、method 取值、content 为空或超过 500 字 400；今天可以；null 时线索的 next_follow_up 也改成 null', async () => {
    const l = await lead();
    const u = `/api/leads/${l.id}/follow-ups`;
    for (const bad of [{ next_follow_up: day(-1) }, { method: 'email' }, { content: '  ' }, { content: 'x'.repeat(501) }]) {
      fail(await req('POST', u, { method: 'phone', content: '沟通', next_follow_up: null, ...bad }), 400);
    }
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'new', '失败的跟进不改线索');
    await followUp(l.id, { next_follow_up: day(0) });
    assert.equal((await get(`/api/leads/${l.id}`)).next_follow_up, day(0));
    await followUp(l.id, { next_follow_up: null });
    assert.equal((await get(`/api/leads/${l.id}`)).next_follow_up, null);
  });
  await check('跟进列表按 id 降序；已约试听的线索加跟进不改状态', async () => {
    const l = await lead();
    const f1 = await followUp(l.id, { content: '第一次' });
    await trial(l.id);
    const f2 = await followUp(l.id, { content: '提醒试听', method: 'visit' });
    assert.deepEqual(pluck(await get(`/api/leads/${l.id}/follow-ups`), 'id'), [f2.id, f1.id]);
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'trial_scheduled');
  });
  await check('已结束的线索不能加跟进 409；sales 给别人的线索看、加跟进 403', async () => {
    const l = await lead();
    await req('POST', `/api/leads/${l.id}/lose`, { reason: '不考虑' });
    fail(await req('POST', `/api/leads/${l.id}/follow-ups`, { method: 'phone', content: 'x', next_follow_up: null }), 409);
    const theirs = await lead({}, s2.token);
    fail(await req('GET', `/api/leads/${theirs.id}/follow-ups`, undefined, { as: s1.token }), 403);
    fail(await req('POST', `/api/leads/${theirs.id}/follow-ups`, { method: 'phone', content: 'x', next_follow_up: null }, { as: s1.token }), 403);
  });

  group('二期·试听');
  await check('创建试听：scheduled、feedback ""，带 lead_name、course_name、teacher_name；线索 → trial_scheduled；teacher_id 可以为 null', async () => {
    const l = await lead();
    await followUp(l.id);
    const t = await trial(l.id);
    assert.equal(t.status, 'scheduled'); assert.equal(t.feedback, ''); assert.equal(t.date, day(3)); assert.equal(t.start_time, '10:00');
    assert.equal(t.lead_name, l.name); assert.equal(t.course_name, S.course.name); assert.equal(t.teacher_name, S.teacher.name);
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'trial_scheduled');
    const l2 = await lead();
    const t2 = await trial(l2.id, { teacher_id: null });
    assert.equal(t2.teacher_id, null); assert.equal(t2.teacher_name, null);
  });
  await check('同一线索同时只能有一个 scheduled 的试听 409；已结束的线索不能约试听 409', async () => {
    const l = await lead();
    await trial(l.id);
    fail(await req('POST', '/api/trials', { lead_id: l.id, course_id: S.course.id, campus_id: S.campus.id, teacher_id: null, date: day(4), start_time: '15:00' }), 409);
    const lost = await lead();
    await req('POST', `/api/leads/${lost.id}/lose`, { reason: '不要了' });
    fail(await req('POST', '/api/trials', { lead_id: lost.id, course_id: S.course.id, campus_id: S.campus.id, teacher_id: null, date: day(4), start_time: '15:00' }), 409);
  });
  await check('试听校验：停用的课程、教师、校区 400；attended 不是布尔 400', async () => {
    const l = await lead();
    const c = await fx.course(S.subject.id);
    await patch(`/api/courses/${c.id}`, { active: false });
    const { teacher } = await fx.teacher(S.campus.id, [S.subject.id], { withUser: false });
    await patch(`/api/teachers/${teacher.id}`, { active: false });
    fail(await req('POST', '/api/trials', { lead_id: l.id, course_id: c.id, campus_id: S.campus.id, teacher_id: null, date: day(3), start_time: '10:00' }), 400);
    fail(await req('POST', '/api/trials', { lead_id: l.id, course_id: S.course.id, campus_id: S.campus.id, teacher_id: teacher.id, date: day(3), start_time: '10:00' }), 400);
    fail(await req('POST', '/api/trials', { lead_id: l.id, course_id: S.course.id, campus_id: off.id, teacher_id: null, date: day(3), start_time: '10:00' }), 400);
    fail(await req('POST', '/api/trials', { lead_id: l.id, course_id: S.course.id, campus_id: S.campus.id, teacher_id: null, date: day(3), start_time: '25:00' }), 400);
    const t = await trial(l.id);
    fail(await req('POST', `/api/trials/${t.id}/complete`, { attended: 'yes', feedback: '' }), 400);
    assert.equal((await get(`/api/trials/${t.id}`)).status, 'scheduled');
  });
  await check('完成试听（到了）：→ attended 并记 feedback，线索 → trialed；之后再完成、取消、PATCH 都是 409', async () => {
    const l = await lead();
    await followUp(l.id);
    const t = await trial(l.id);
    const r = ok(await req('POST', `/api/trials/${t.id}/complete`, { attended: true, feedback: '孩子很投入' }));
    assert.equal(r.status, 'attended'); assert.equal(r.feedback, '孩子很投入');
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'trialed');
    fail(await req('POST', `/api/trials/${t.id}/complete`, { attended: false, feedback: '' }), 409);
    fail(await req('POST', `/api/trials/${t.id}/cancel`, {}), 409);
    fail(await req('PATCH', `/api/trials/${t.id}`, { start_time: '11:00' }), 409);
  });
  await check('完成试听（没到）：→ absent，线索改回 contacted', async () => {
    const l = await lead();
    await followUp(l.id);
    const t = await trial(l.id);
    assert.equal(ok(await req('POST', `/api/trials/${t.id}/complete`, { attended: false, feedback: '' })).status, 'absent');
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'contacted');
  });
  await check('取消试听：→ cancelled，线索改回 contacted；之后可以再约一个', async () => {
    const l = await lead();
    await followUp(l.id);
    const t = await trial(l.id);
    assert.equal(ok(await req('POST', `/api/trials/${t.id}/cancel`, {})).status, 'cancelled');
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'contacted');
    await trial(l.id, { date: day(5) });
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'trial_scheduled');
  });
  await check('scheduled 的试听可以 PATCH 课程、教师、日期（过去的也行）、时刻，teacher_name 跟着变', async () => {
    const l = await lead();
    const t = await trial(l.id);
    const c2 = await fx.course(S.subject.id);
    const { teacher } = await fx.teacher(S.campus.id, [S.subject.id], { withUser: false });
    const r = await patch(`/api/trials/${t.id}`, { course_id: c2.id, teacher_id: teacher.id, date: day(-5), start_time: '16:30' });
    assert.equal(r.course_id, c2.id); assert.equal(r.course_name, c2.name);
    assert.equal(r.teacher_id, teacher.id); assert.equal(r.teacher_name, teacher.name);
    assert.equal(r.date, day(-5)); assert.equal(r.start_time, '16:30'); assert.equal(r.status, 'scheduled');
  });
  await check('试听列表：按 date、start_time、id 升序；lead_id、status 筛选；sales 只看到自己负责的线索的试听，别人的 403', async () => {
    const l = await lead({}, s1.token);
    const t1 = await trial(l.id, { date: day(6), start_time: '09:00' }, s1.token);
    await req('POST', `/api/trials/${t1.id}/complete`, { attended: false, feedback: '' }, { as: s1.token });
    const t2 = await trial(l.id, { date: day(4), start_time: '18:00' }, s1.token);
    await req('POST', `/api/trials/${t2.id}/cancel`, {}, { as: s1.token });
    const t3 = await trial(l.id, { date: day(4), start_time: '08:00' }, s1.token);
    assert.deepEqual(pluck(await list(`/api/trials?lead_id=${l.id}`), 'id'), [t3.id, t2.id, t1.id]);
    assert.deepEqual(pluck(await list(`/api/trials?lead_id=${l.id}&status=scheduled`), 'id'), [t3.id]);
    const theirs = await trial((await lead({}, s2.token)).id, {}, s2.token);
    const seen = await list('/api/trials?page_size=100', s1.token);
    assert.ok(seen.some((t) => t.id === t3.id)); assert.ok(!seen.some((t) => t.id === theirs.id));
    fail(await req('GET', `/api/trials/${theirs.id}`, undefined, { as: s1.token }), 403);
    fail(await req('POST', `/api/trials/${theirs.id}/cancel`, {}, { as: s1.token }), 403);
  });

  group('二期·线索转化');
  await check('转化：没给的学员字段取线索的 name、grade、phone、campus_id；返回 201 与新学员；线索 → converted 并填 student_id', async () => {
    const l = await trialedLead({ grade: 6 });
    const s = ok(await req('POST', `/api/leads/${l.id}/convert`, {}), 201);
    assert.match(s.no, /^S\d{6}$/);
    assert.equal(s.name, l.name); assert.equal(s.grade, 6); assert.equal(s.phone, l.phone); assert.equal(s.campus_id, S.campus.id); assert.equal(s.status, 'active');
    const r = await get(`/api/leads/${l.id}`);
    assert.equal(r.status, 'converted'); assert.equal(r.student_id, s.id);
    assert.equal((await get(`/api/students/${s.id}`)).name, l.name);
  });
  await check('转化时给出的学员字段优先（姓名、性别、出生日期、学校、校区）', async () => {
    const l = await trialedLead();
    const s = ok(await req('POST', `/api/leads/${l.id}/convert`, { name: '王小虎', gender: 'male', birth_date: '2016-05-01', school: '育才小学', campus_id: C2.id }), 201);
    assert.equal(s.name, '王小虎'); assert.equal(s.gender, 'male'); assert.equal(s.birth_date, '2016-05-01'); assert.equal(s.school, '育才小学');
    assert.equal(s.campus_id, C2.id); assert.equal(s.grade, l.grade);
  });
  await check('转化的学员字段不合法 400，线索不变；已结束（已转化、已流失）的线索转化 409，已转化的不能 PATCH 409', async () => {
    const l = await trialedLead();
    fail(await req('POST', `/api/leads/${l.id}/convert`, { birth_date: day(1) }), 400);
    fail(await req('POST', `/api/leads/${l.id}/convert`, { campus_id: off.id }), 400);
    const again = await get(`/api/leads/${l.id}`);
    assert.equal(again.status, 'trialed'); assert.equal(again.student_id, null);
    ok(await req('POST', `/api/leads/${l.id}/convert`, {}), 201);
    fail(await req('POST', `/api/leads/${l.id}/convert`, {}), 409);
    fail(await req('PATCH', `/api/leads/${l.id}`, { name: 'x' }), 409);
    const lost = await lead();
    await req('POST', `/api/leads/${lost.id}/lose`, { reason: '不来了' });
    fail(await req('POST', `/api/leads/${lost.id}/convert`, {}), 409);
  });
  await check('没走完流程也能转化（已约试听时直接转化）；线索结束后完成或取消它的试听不改线索状态', async () => {
    const l = await lead();
    const t = await trial(l.id);
    ok(await req('POST', `/api/leads/${l.id}/convert`, {}), 201);
    assert.equal(ok(await req('POST', `/api/trials/${t.id}/complete`, { attended: true, feedback: '' })).status, 'attended');
    assert.equal((await get(`/api/leads/${l.id}`)).status, 'converted');
    const l2 = await lead();
    const t2 = await trial(l2.id);
    ok(await req('POST', `/api/leads/${l2.id}/lose`, { reason: '搬家' }));
    assert.equal(ok(await req('POST', `/api/trials/${t2.id}/cancel`, {})).status, 'cancelled');
    assert.equal((await get(`/api/leads/${l2.id}`)).status, 'lost');
  });
  await check('sales 转化别人的线索 403；转化后同一手机号可以新建线索', async () => {
    const theirs = await trialedLead({}, s2.token);
    fail(await req('POST', `/api/leads/${theirs.id}/convert`, {}, { as: s1.token }), 403);
    assert.equal((await get(`/api/leads/${theirs.id}`)).status, 'trialed');
    ok(await req('POST', `/api/leads/${theirs.id}/convert`, {}, { as: s2.token }), 201);
    ok(await req('POST', '/api/leads', { name: '老学员介绍', phone: theirs.phone, source: 'referral', campus_id: S.campus.id }), 201);
  });

  group('二期·优惠');
  await check('创建优惠：默认 min_amount 0、valid_from/valid_to null、active true，used false', async () => {
    const d = await discount({ type: 'percent', value: 15 });
    assert.equal(d.type, 'percent'); assert.equal(d.value, 15); assert.equal(d.min_amount, 0);
    assert.equal(d.valid_from, null); assert.equal(d.valid_to, null); assert.equal(d.active, true); assert.equal(d.used, false);
  });
  await check('优惠校验：名称重复 409；type、percent 不在 1–90 或不是整数、amount 不在 1–10000000、valid_from 晚于 valid_to 都是 400', async () => {
    const d = await discount();
    fail(await req('POST', '/api/discounts', { name: d.name, type: 'amount', value: 100 }), 409);
    for (const bad of [{ type: 'gift' }, { type: 'percent', value: 0 }, { type: 'percent', value: 91 }, { type: 'percent', value: 12.5 }, { type: 'amount', value: 0 }, { type: 'amount', value: 10000001 }, { valid_from: day(5), valid_to: day(4) }, { name: ' ' }]) {
      fail(await req('POST', '/api/discounts', { name: tag('坏'), type: 'amount', value: 100, ...bad }), 400);
    }
    ok(await req('POST', '/api/discounts', { name: tag('当天'), type: 'percent', value: 90, valid_from: day(0), valid_to: day(0) }), 201);
  });
  await check('优惠列表 usable=true 只返回今天可用的（启用且今天在有效期内，null 一端不限）；active 筛选', async () => {
    const good = [await discount(), await discount({ valid_from: day(-3), valid_to: day(0) }), await discount({ valid_from: day(0) })];
    const bad = [await discount({ valid_to: day(-1) }), await discount({ valid_from: day(1) }), await discount({ active: false })];
    const usable = pluck(await list('/api/discounts?usable=true&page_size=100'), 'id');
    for (const d of good) assert.ok(usable.includes(d.id), `${d.name} 应可用`);
    for (const d of bad) assert.ok(!usable.includes(d.id), `${d.name} 不应可用`);
    const inactive = await list('/api/discounts?active=false&page_size=100');
    assert.ok(inactive.every((d) => d.active === false)); assert.ok(inactive.some((d) => d.id === bad[2].id));
    fail(await req('GET', '/api/discounts?usable=yes'), 400);
  });
  await check('被订单用过（含待支付、已取消）的优惠 used 为 true，不能删除、不能改 type 与 value 409；可以改名与停用；没用过的能删 204', async () => {
    const st = await fx.student(S.campus.id);
    const d1 = await discount();
    await order(st.id, [{ course_id: S.course.id, lessons: 1 }], { discount_id: d1.id });
    const d2 = await discount();
    const o2 = await order(st.id, [{ course_id: S.course.id, lessons: 1 }], { discount_id: d2.id });
    await act(`/api/orders/${o2.id}/cancel`);
    for (const d of [d1, d2]) {
      assert.equal((await get(`/api/discounts/${d.id}`)).used, true);
      fail(await req('DELETE', `/api/discounts/${d.id}`), 409);
      fail(await req('PATCH', `/api/discounts/${d.id}`, { value: 500 }), 409);
      // 同时给合法的 value：只给 type 时 percent 配原来的 1000 本身也不合法（400），两条 400/409 的先后 PRD 没规定
      fail(await req('PATCH', `/api/discounts/${d.id}`, { type: 'percent', value: 10 }), 409);
    }
    const r = await patch(`/api/discounts/${d1.id}`, { name: tag('改名'), active: false });
    assert.equal(r.active, false); assert.equal(r.value, 1000);
    const unused = await discount();
    await del(`/api/discounts/${unused.id}`);
  });
  await check('权限：finance 能建优惠；sales 能读不能建 403；academic、teacher 读 403', async () => {
    const f = await fx.user('finance');
    ok(await req('POST', '/api/discounts', { name: tag('财务建'), type: 'amount', value: 100 }, { as: f.token }), 201);
    ok(await req('GET', '/api/discounts', undefined, { as: s1.token }));
    fail(await req('POST', '/api/discounts', { name: tag('顾问建'), type: 'amount', value: 100 }, { as: s1.token }), 403);
    for (const role of ['academic', 'teacher']) fail(await req('GET', '/api/discounts', undefined, { as: (await fx.user(role)).token }), 403);
  });

  // —— 订单 ——
  const cA = S.course; // 10000/节
  const cB = await fx.course(S.subject.id, { price_per_lesson: 3333 });
  const cC = await fx.course(S.subject.id);
  const cD = await fx.course(S.subject.id);

  group('二期·订单金额');
  await check('不用优惠：每行 amount = lessons × 单价，original 是各行之和，discount 0，payable = original，discount_share 0', async () => {
    const st = await fx.student(S.campus.id);
    const o = await order(st.id, [{ course_id: cA.id, lessons: 3 }, { course_id: cB.id, lessons: 7 }]);
    // 3 × 10000 = 30000；7 × 3333 = 23331；合计 53331
    const a = o.items.find((i) => i.course_id === cA.id);
    const b = o.items.find((i) => i.course_id === cB.id);
    assert.equal(a.price_per_lesson, 10000); assert.equal(a.amount, 30000); assert.equal(a.discount_share, 0); assert.equal(a.paid_amount, 30000);
    assert.equal(b.price_per_lesson, 3333); assert.equal(b.amount, 23331); assert.equal(b.paid_amount, 23331); assert.equal(b.course_name, cB.name);
    assert.equal(o.original_amount, 53331); assert.equal(o.discount_amount, 0); assert.equal(o.payable_amount, 53331); assert.equal(o.discount_id, null);
  });
  await check('按比例减：discount = floor(original × value / 100)；除最后一行外 share = floor(discount × 行 amount / original)，最后一行拿剩下的', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ type: 'percent', value: 15 });
    const o = await order(st.id, [{ course_id: cA.id, lessons: 3 }, { course_id: cB.id, lessons: 7 }], { discount_id: d.id });
    // original 53331；discount = floor(53331 × 15 / 100) = floor(7999.65) = 7999；payable 45332
    // 第一行 share = floor(7999 × 30000 / 53331) = floor(4499.63) = 4499，paid 25501；最后一行 share = 7999 − 4499 = 3500，paid 23331 − 3500 = 19831
    assert.equal(o.discount_amount, 7999); assert.equal(o.payable_amount, 45332); assert.equal(o.discount_id, d.id);
    const a = o.items.find((i) => i.course_id === cA.id);
    const b = o.items.find((i) => i.course_id === cB.id);
    assert.equal(a.discount_share, 4499); assert.equal(a.paid_amount, 25501);
    assert.equal(b.discount_share, 3500); assert.equal(b.paid_amount, 19831);
  });
  await check('立减分摊三行：1000 分摊到 10000、10000、10000 → 333、333、最后一行 334', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ type: 'amount', value: 1000 });
    const o = await order(st.id, [{ course_id: cA.id, lessons: 1 }, { course_id: cC.id, lessons: 1 }, { course_id: cD.id, lessons: 1 }], { discount_id: d.id });
    // floor(1000 × 10000 / 30000) = 333；最后一行 1000 − 333 − 333 = 334
    assert.equal(o.original_amount, 30000); assert.equal(o.discount_amount, 1000); assert.equal(o.payable_amount, 29000);
    const by = (c) => o.items.find((i) => i.course_id === c.id);
    assert.deepEqual([by(cA).discount_share, by(cC).discount_share, by(cD).discount_share], [333, 333, 334]);
    assert.deepEqual([by(cA).paid_amount, by(cC).paid_amount, by(cD).paid_amount], [9667, 9667, 9666]);
  });
  await check('立减超过原价：discount = min(value, original)，应付 0；按 0 支付成功', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ type: 'amount', value: 50000 });
    const o = await order(st.id, [{ course_id: cA.id, lessons: 1 }], { discount_id: d.id });
    // min(50000, 10000) = 10000；唯一一行就是最后一行，share 10000，paid 0
    assert.equal(o.discount_amount, 10000); assert.equal(o.payable_amount, 0);
    assert.equal(o.items[0].discount_share, 10000); assert.equal(o.items[0].paid_amount, 0);
    assert.equal((await act(`/api/orders/${o.id}/pay`, { method: 'cash', amount: 0 })).status, 'paid');
  });
  await check('优惠门槛与有效期：original 等于 min_amount 可用，低于 400；停用、已过期、还没开始的优惠 400', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ type: 'amount', value: 500, min_amount: 20000 });
    const o = await order(st.id, [{ course_id: cA.id, lessons: 2 }], { discount_id: d.id });
    assert.equal(o.discount_amount, 500); assert.equal(o.payable_amount, 19500);
    const one = { student_id: st.id, items: [{ course_id: cA.id, lessons: 1 }], note: '' };
    fail(await req('POST', '/api/orders', { ...one, discount_id: d.id }), 400);
    for (const bad of [{ active: false }, { valid_to: day(-1) }, { valid_from: day(1) }]) {
      fail(await req('POST', '/api/orders', { ...one, discount_id: (await discount(bad)).id }), 400);
    }
    const today = await discount({ valid_from: day(0), valid_to: day(0) });
    ok(await req('POST', '/api/orders', { ...one, discount_id: today.id }), 201);
  });
  await check('单价取下单时的：改课程单价不影响已有订单；PATCH items 按当时的单价重新计算', async () => {
    const st = await fx.student(S.campus.id);
    const cE = await fx.course(S.subject.id);
    const o = await order(st.id, [{ course_id: cE.id, lessons: 2 }]);
    await patch(`/api/courses/${cE.id}`, { price_per_lesson: 12000 });
    const same = await get(`/api/orders/${o.id}`);
    assert.equal(same.items[0].price_per_lesson, 10000); assert.equal(same.original_amount, 20000);
    const o2 = await order(st.id, [{ course_id: cE.id, lessons: 2 }]);
    assert.equal(o2.original_amount, 24000);
    const r = await patch(`/api/orders/${o.id}`, { items: [{ course_id: cE.id, lessons: 3 }] });
    // 3 × 12000 = 36000
    assert.equal(r.items.length, 1); assert.equal(r.items[0].price_per_lesson, 12000); assert.equal(r.items[0].amount, 36000);
    assert.equal(r.original_amount, 36000); assert.equal(r.payable_amount, 36000);
  });
  await check('PATCH 待支付订单的 discount_id、note：金额重新计算；不满足门槛的优惠 400 且订单不变', async () => {
    const st = await fx.student(S.campus.id);
    const o = await order(st.id, [{ course_id: cA.id, lessons: 2 }]);
    const pct = await discount({ type: 'percent', value: 10 });
    const r = await patch(`/api/orders/${o.id}`, { discount_id: pct.id, note: '老带新' });
    // floor(20000 × 10 / 100) = 2000
    assert.equal(r.discount_amount, 2000); assert.equal(r.payable_amount, 18000); assert.equal(r.items[0].paid_amount, 18000); assert.equal(r.note, '老带新');
    const high = await discount({ min_amount: 30000 });
    fail(await req('PATCH', `/api/orders/${o.id}`, { discount_id: high.id }), 400);
    const now = await get(`/api/orders/${o.id}`);
    assert.equal(now.discount_id, pct.id); assert.equal(now.payable_amount, 18000);
    const cleared = await patch(`/api/orders/${o.id}`, { discount_id: null });
    assert.equal(cleared.discount_amount, 0); assert.equal(cleared.payable_amount, 20000);
  });

  await check('只改 discount_id 时各行沿用原来的单价（课程改价后也不变），按新优惠重新计算', async () => {
    const st = await fx.student(S.campus.id);
    const cF = await fx.course(S.subject.id);
    const o = await order(st.id, [{ course_id: cF.id, lessons: 2 }]);
    await patch(`/api/courses/${cF.id}`, { price_per_lesson: 15000 });
    const pct = await discount({ type: 'percent', value: 10 });
    const r = await patch(`/api/orders/${o.id}`, { discount_id: pct.id });
    // 仍是 2 × 10000 = 20000；floor(20000 × 10 / 100) = 2000
    assert.equal(r.items[0].price_per_lesson, 10000); assert.equal(r.items[0].amount, 20000);
    assert.equal(r.original_amount, 20000); assert.equal(r.discount_amount, 2000); assert.equal(r.payable_amount, 18000);
  });

  group('二期·订单与收据');
  await check('订单字段：no 是 OD+6 位且递增，pending，paid_at、payment_method 为 null，带 student_name、student_no、created_by', async () => {
    const st = await fx.student(S.campus.id);
    const a = await order(st.id, [{ course_id: cA.id, lessons: 1 }], { note: ' 首单 ' });
    const b = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    assert.match(a.no, /^OD\d{6}$/); assert.ok(Number(b.no.slice(2)) > Number(a.no.slice(2)));
    assert.equal(a.status, 'pending'); assert.equal(a.paid_at, null); assert.equal(a.payment_method, null); assert.equal(a.note, '首单');
    assert.equal(a.student_id, st.id); assert.equal(a.student_name, st.name); assert.equal(a.student_no, st.no);
    assert.equal(a.created_by, admin.id); assert.equal(typeof a.created_at, 'string');
    assert.equal(typeof a.items[0].id, 'number');
    assert.deepEqual(await get(`/api/orders/${a.id}`), (await list(`/api/orders?student_id=${st.id}`)).find((x) => x.id === a.id));
  });
  await check('下单校验 400：items 为空或超过 10 行、同一课程两次、lessons 不在 1–200、课程停用或不存在、学员或优惠不存在、note 超过 200 字', async () => {
    const st = await fx.student(S.campus.id);
    const offCourse = await fx.course(S.subject.id);
    await patch(`/api/courses/${offCourse.id}`, { active: false });
    const eleven = [];
    for (let i = 0; i < 11; i++) eleven.push({ course_id: (await fx.course(S.subject.id)).id, lessons: 1 });
    const one = [{ course_id: cA.id, lessons: 1 }];
    for (const bad of [{ items: [] }, { items: eleven }, { items: [{ course_id: cA.id, lessons: 1 }, { course_id: cA.id, lessons: 2 }] }, { items: [{ course_id: cA.id, lessons: 0 }] },
      { items: [{ course_id: cA.id, lessons: 201 }] }, { items: [{ course_id: offCourse.id, lessons: 1 }] }, { items: [{ course_id: 99999, lessons: 1 }] },
      { student_id: 99999 }, { discount_id: 99999 }, { note: 'x'.repeat(201) }]) {
      fail(await req('POST', '/api/orders', { student_id: st.id, items: one, discount_id: null, note: '', ...bad }), 400);
    }
    assert.deepEqual(await list(`/api/orders?student_id=${st.id}`), []);
    ok(await req('POST', '/api/orders', { student_id: st.id, items: eleven.slice(0, 10), discount_id: null, note: '' }), 201);
  });
  await check('支付：金额不等于应付 400、方式取值不对 400、用余额（第四期前余额总是 0）409，都不改订单、不生成课时包', async () => {
    const st = await fx.student(S.campus.id);
    const o = await order(st.id, [{ course_id: cA.id, lessons: 2 }]);
    fail(await req('POST', `/api/orders/${o.id}/pay`, { method: 'cash', amount: 19999 }), 400);
    fail(await req('POST', `/api/orders/${o.id}/pay`, { method: 'bitcoin', amount: 20000 }), 400);
    fail(await req('POST', `/api/orders/${o.id}/pay`, { method: 'balance', amount: 20000 }), 409);
    const now = await get(`/api/orders/${o.id}`);
    assert.equal(now.status, 'pending'); assert.equal(now.paid_at, null);
    assert.deepEqual(await get(`/api/students/${st.id}/packages`), []);
  });
  await check('支付成功：pending → paid，填 paid_at、payment_method；再付 409；已支付的不能取消、PATCH、删除 409', async () => {
    const st = await fx.student(S.campus.id);
    const o = await order(st.id, [{ course_id: cA.id, lessons: 2 }]);
    const r = await act(`/api/orders/${o.id}/pay`, { method: 'wechat', amount: 20000 });
    assert.equal(r.status, 'paid'); assert.equal(r.payment_method, 'wechat'); assert.equal(typeof r.paid_at, 'string');
    fail(await req('POST', `/api/orders/${o.id}/pay`, { method: 'cash', amount: 20000 }), 409);
    fail(await req('POST', `/api/orders/${o.id}/cancel`, {}), 409);
    fail(await req('PATCH', `/api/orders/${o.id}`, { note: 'x' }), 409);
    fail(await req('DELETE', `/api/orders/${o.id}`), 409);
    assert.equal((await get(`/api/orders/${o.id}`)).status, 'paid');
  });
  await check('支付记一条 payment 类型的收款流水：金额为应付、方式与订单一致、带 order_id 与 PY+6 位单号', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ value: 1500 });
    const o = await fx.paidOrder(st.id, [{ course_id: cA.id, lessons: 2 }], { method: 'alipay', discount_id: d.id });
    const rows = await list(`/api/payments?student_id=${st.id}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'payment'); assert.equal(rows[0].amount, 18500); assert.equal(rows[0].method, 'alipay');
    assert.equal(rows[0].order_id, o.id); assert.equal(rows[0].refund_id, null); assert.match(rows[0].no, /^PY\d{6}$/);
  });
  await check('取消：pending → cancelled；已取消的不能支付、PATCH、删除、再取消 409；待支付的能删除 204', async () => {
    const st = await fx.student(S.campus.id);
    const o = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    assert.equal((await act(`/api/orders/${o.id}/cancel`)).status, 'cancelled');
    fail(await req('POST', `/api/orders/${o.id}/pay`, { method: 'cash', amount: 10000 }), 409);
    fail(await req('PATCH', `/api/orders/${o.id}`, { note: 'x' }), 409);
    fail(await req('DELETE', `/api/orders/${o.id}`), 409);
    fail(await req('POST', `/api/orders/${o.id}/cancel`, {}), 409);
    const p = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    await del(`/api/orders/${p.id}`);
    fail(await req('GET', `/api/orders/${p.id}`), 404);
  });
  await check('订单列表：按 id 降序；student_id、status、q（单号）、from/to（下单日期）筛选；from 晚于 to 400', async () => {
    const st = await fx.student(S.campus.id);
    const a = await fx.paidOrder(st.id, [{ course_id: cA.id, lessons: 1 }]);
    const b = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    const c = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    const u = `/api/orders?student_id=${st.id}`;
    assert.deepEqual(pluck(await list(u), 'id'), [c.id, b.id, a.id]);
    assert.deepEqual(pluck(await list(`${u}&status=paid`), 'id'), [a.id]);
    assert.deepEqual(pluck(await list(`/api/orders?q=${b.no}`), 'id'), [b.id]);
    assert.deepEqual(pluck(await list(`${u}&from=${day(0)}&to=${day(0)}`), 'id'), [c.id, b.id, a.id]);
    assert.deepEqual(await list(`${u}&from=${day(1)}`), []);
    assert.ok(isDesc(pluck(await list('/api/orders?page_size=100'), 'id')));
    fail(await req('GET', `/api/orders?from=${day(1)}&to=${day(0)}`), 400);
    fail(await req('GET', '/api/orders?status=done'), 400);
  });
  await check('收据：未支付 409；字段与订单一致，receipt_no 是 RC+6 位，第一次查看时生成（先看的单号小）且之后不变', async () => {
    const st = await fx.student(S.campus.id);
    const d = await discount({ type: 'percent', value: 15 });
    const pending = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    fail(await req('GET', `/api/orders/${pending.id}/receipt`), 409);
    const first = await fx.paidOrder(st.id, [{ course_id: cA.id, lessons: 3 }, { course_id: cB.id, lessons: 7 }], { method: 'card', discount_id: d.id });
    const second = await fx.paidOrder(st.id, [{ course_id: cC.id, lessons: 1 }]);
    const r2 = await get(`/api/orders/${second.id}/receipt`); // 后支付的先看
    const r1 = await get(`/api/orders/${first.id}/receipt`);
    assert.match(r1.receipt_no, /^RC\d{6}$/); assert.match(r2.receipt_no, /^RC\d{6}$/);
    assert.ok(Number(r2.receipt_no.slice(2)) < Number(r1.receipt_no.slice(2)), `先查看的收据单号应更小：${r2.receipt_no} ${r1.receipt_no}`);
    assert.equal((await get(`/api/orders/${first.id}/receipt`)).receipt_no, r1.receipt_no);
    assert.equal(r1.order_no, first.no); assert.equal(r1.student_name, st.name); assert.equal(r1.student_no, st.no);
    assert.equal(r1.original_amount, 53331); assert.equal(r1.discount_amount, 7999); assert.equal(r1.payable_amount, 45332);
    assert.equal(r1.payment_method, 'card'); assert.equal(r1.paid_at, first.paid_at);
    const items = r1.items.map((i) => ({ course_name: i.course_name, lessons: i.lessons, paid_amount: i.paid_amount })).sort((x, y) => x.paid_amount - y.paid_amount);
    assert.deepEqual(items, [{ course_name: cB.name, lessons: 7, paid_amount: 19831 }, { course_name: cA.name, lessons: 3, paid_amount: 25501 }]);
    const cancelled = await order(st.id, [{ course_id: cA.id, lessons: 1 }]);
    await act(`/api/orders/${cancelled.id}/cancel`);
    fail(await req('GET', `/api/orders/${cancelled.id}/receipt`), 409);
  });
  await check('权限：sales 能下单与支付；academic、finance 能读不能下单 403；teacher、parent 403', async () => {
    const st = await fx.student(S.campus.id);
    const o = await fx.paidOrder(st.id, [{ course_id: cA.id, lessons: 1 }], { as: s1.token });
    assert.equal(o.status, 'paid'); assert.equal(o.created_by, s1.user.id);
    const body = { student_id: st.id, items: [{ course_id: cA.id, lessons: 1 }], discount_id: null, note: '' };
    for (const role of ['academic', 'finance']) {
      const u = await fx.user(role);
      ok(await req('GET', `/api/orders/${o.id}`, undefined, { as: u.token }));
      ok(await req('GET', `/api/orders/${o.id}/receipt`, undefined, { as: u.token }));
      fail(await req('POST', '/api/orders', body, { as: u.token }), 403);
    }
    const t = await fx.user('teacher');
    fail(await req('GET', '/api/orders', undefined, { as: t.token }), 403);
    const p = await fx.parentOf([st.id]);
    fail(await req('GET', `/api/orders/${o.id}`, undefined, { as: p.token }), 403);
  });
  await check('名称字段：线索带 interest_course_name，订单带 discount_name、created_by_name，试听带 campus_name', async () => {
    const l = await lead();
    assert.equal(l.interest_course_name, S.course.name);
    const t = await trial(l.id);
    assert.equal(t.campus_name, S.campus.name);
    const st = await fx.student(S.campus.id);
    const d = await discount();
    const o = await order(st.id, [{ course_id: cA.id, lessons: 1 }], { discount_id: d.id });
    assert.equal(o.discount_name, d.name); assert.equal(o.created_by_name, admin.name);
  });

  group('二期·课时包与账户');
  // 一个学员：订单 1（15% 优惠，cA 3 节 paid 25501、cB 7 节 paid 19831），订单 2（cA 2 节，20000）
  const P = {};
  await check('支付后每一行生成一个课时包：lessons = remaining，paid_amount 是这一行的实付，确认与释放为 0，带 order_id、order_item_id', async () => {
    P.st = await fx.student(S.campus.id);
    const d = await discount({ type: 'percent', value: 15 });
    P.o1 = await fx.paidOrder(P.st.id, [{ course_id: cA.id, lessons: 3 }, { course_id: cB.id, lessons: 7 }], { discount_id: d.id });
    P.o2 = await fx.paidOrder(P.st.id, [{ course_id: cA.id, lessons: 2 }]);
    const pk = await get(`/api/students/${P.st.id}/packages`);
    assert.equal(pk.length, 3); assert.ok(isDesc([...pluck(pk, 'id')].reverse()), '按 id 升序');
    const itemA = P.o1.items.find((i) => i.course_id === cA.id);
    const a = pk.find((x) => x.order_item_id === itemA.id);
    assert.equal(a.student_id, P.st.id); assert.equal(a.course_id, cA.id); assert.equal(a.order_id, P.o1.id); assert.equal(a.course_transfer_id, null);
    assert.equal(a.lessons, 3); assert.equal(a.remaining, 3); assert.equal(a.paid_amount, 25501);
    assert.equal(a.recognized_amount, 0); assert.equal(a.released_amount, 0); assert.equal(typeof a.created_at, 'string');
    assert.equal(pk.find((x) => x.course_id === cB.id).paid_amount, 19831);
    assert.deepEqual(pluck(await get(`/api/students/${P.st.id}/packages?course_id=${cA.id}`), 'order_id'), [P.o1.id, P.o2.id]);
  });
  await check('待支付、已取消的订单不生成课时包，也没有账户与流水', async () => {
    const st = await fx.student(S.campus.id);
    await order(st.id, [{ course_id: cA.id, lessons: 2 }]);
    const c = await order(st.id, [{ course_id: cB.id, lessons: 2 }]);
    await act(`/api/orders/${c.id}/cancel`);
    assert.deepEqual(await get(`/api/students/${st.id}/packages`), []);
    assert.deepEqual(await get(`/api/students/${st.id}/accounts`), []);
    assert.deepEqual(await get(`/api/students/${st.id}/ledger`), []);
  });
  await check('课时账户：每门课一项，purchased 是购买课时之和，remaining 是包的 remaining 之和，remaining_value 是剩余价值之和，按 course_id 升序', async () => {
    const keys = ['course_id', 'course_name', 'purchased', 'consumed', 'refunded', 'transferred_out', 'transferred_in', 'remaining', 'remaining_value'];
    const acc = (await get(`/api/students/${P.st.id}/accounts`)).map((a) => Object.fromEntries(keys.map((x) => [x, a[x]])));
    // cA：3 + 2 = 5 节，25501 + 20000 = 45501；cB：7 节，19831
    assert.deepEqual(acc, [
      { course_id: cA.id, course_name: cA.name, purchased: 5, consumed: 0, refunded: 0, transferred_out: 0, transferred_in: 0, remaining: 5, remaining_value: 45501 },
      { course_id: cB.id, course_name: cB.name, purchased: 7, consumed: 0, refunded: 0, transferred_out: 0, transferred_in: 0, remaining: 7, remaining_value: 19831 },
    ]);
  });
  await check('课时流水：每个课时包一条 purchase（delta 为课时数，ref_type order，ref_id 订单编号），按 id 升序；course_id 筛选', async () => {
    const pk = await get(`/api/students/${P.st.id}/packages`);
    const led = await get(`/api/students/${P.st.id}/ledger`);
    assert.equal(led.length, 3); assert.ok(isDesc([...pluck(led, 'id')].reverse()), '按 id 升序');
    for (const p of pk) {
      const e = led.find((x) => x.package_id === p.id);
      assert.ok(e, `课时包 ${p.id} 应有购买流水`);
      assert.equal(e.course_id, p.course_id); assert.equal(e.delta, p.lessons); assert.equal(e.reason, 'purchase');
      assert.equal(e.ref_type, 'order'); assert.equal(e.ref_id, p.order_id); assert.equal(typeof e.created_at, 'string');
    }
    const onlyB = await get(`/api/students/${P.st.id}/ledger?course_id=${cB.id}`);
    assert.equal(onlyB.length, 1); assert.equal(onlyB[0].delta, 7);
  });
  await check('权限：academic、finance、sales 能读课时包与账户；teacher 403；家长能读自己孩子的，别人的 403', async () => {
    for (const role of ['academic', 'finance']) ok(await req('GET', `/api/students/${P.st.id}/accounts`, undefined, { as: (await fx.user(role)).token }));
    ok(await req('GET', `/api/students/${P.st.id}/ledger`, undefined, { as: s1.token }));
    const t = await fx.user('teacher');
    fail(await req('GET', `/api/students/${P.st.id}/packages`, undefined, { as: t.token }), 403);
    const p = await fx.parentOf([P.st.id]);
    assert.equal((await get(`/api/students/${P.st.id}/accounts`, p.token)).length, 2);
    ok(await req('GET', `/api/students/${P.st.id}/ledger`, undefined, { as: p.token }));
    const other = await fx.student(S.campus.id);
    fail(await req('GET', `/api/students/${other.id}/packages`, undefined, { as: p.token }), 403);
  });
}
