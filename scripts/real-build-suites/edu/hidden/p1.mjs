// 第一期：登录、用户与权限、基础资料（REQ-002–REQ-011）。REQ-001 的启动与持久化在 ../hidden.mjs。
import { assert, check, del, expectError, fail, fx, get, group, list, login, ok, patch, pluck, post, put, req } from './lib.mjs';

export async function run() {
  group('一期·登录与通用约定');
  await check('登录返回 token 与当前用户结构（无密码；teacher_id 为 null，student_ids 为 []）；用户名不区分大小写', async () => {
    const r = ok(await req('POST', '/api/auth/login', { username: 'ADMIN', password: 'admin123' }, { as: null }));
    assert.equal(typeof r.token, 'string');
    assert.deepEqual(Object.keys(r.user).sort(), ['id', 'name', 'role', 'student_ids', 'teacher_id', 'username']);
    assert.equal(r.user.teacher_id, null); assert.deepEqual(r.user.student_ids, []);
  });
  await check('密码不对、用户不存在都是 401 unauthorized', async () => {
    fail(await req('POST', '/api/auth/login', { username: 'admin', password: 'nope' }, { as: null }), 401);
    fail(await req('POST', '/api/auth/login', { username: 'ghost', password: 'admin123' }, { as: null }), 401);
  });
  await check('没有令牌、令牌无效 401', async () => {
    fail(await req('GET', '/api/auth/me', undefined, { as: null }), 401);
    fail(await req('GET', '/api/campuses', undefined, { as: 'bogus-token' }), 401);
  });
  await check('请求体不是合法 JSON 或不是对象 → 400 invalid_json；路径编号不是正整数 → 404', async () => {
    expectError(await req('POST', '/api/campuses', '{bad', { raw: true }), 400, 'invalid_json');
    expectError(await req('POST', '/api/campuses', []), 400, 'invalid_json');
    fail(await req('GET', '/api/campuses/abc'), 404);
    fail(await req('GET', '/api/campuses/0'), 404);
    fail(await req('GET', '/api/campuses/99999'), 404);
  });
  await check('退出返回 204，之后这个令牌无效', async () => {
    const t = await login('admin', 'admin123');
    assert.equal((await req('POST', '/api/auth/logout', undefined, { as: t })).status, 204);
    fail(await req('GET', '/api/auth/me', undefined, { as: t }), 401);
  });
  await check('改密码：旧密码不对 400、新密码太短 400；成功 204 后其他令牌失效、当前令牌仍有效', async () => {
    const u = await fx.user('sales');
    const other = await login(u.user.username, u.password);
    fail(await req('POST', '/api/auth/password', { old_password: 'wrong1', new_password: 'newpass1' }, { as: u.token }), 400);
    fail(await req('POST', '/api/auth/password', { old_password: u.password, new_password: '123' }, { as: u.token }), 400);
    assert.equal((await req('POST', '/api/auth/password', { old_password: u.password, new_password: 'newpass1' }, { as: u.token })).status, 204);
    fail(await req('GET', '/api/auth/me', undefined, { as: other }), 401);
    ok(await req('GET', '/api/auth/me', undefined, { as: u.token }));
    await login(u.user.username, 'newpass1');
  });

  group('一期·用户与权限');
  const ids = {};
  await check('创建用户：用户名存为小写，默认 phone ""、active true，响应不含密码', async () => {
    const u = await post('/api/users', { username: 'Wang_Fang', password: 'secret12', name: ' 王芳 ', role: 'sales' });
    assert.equal(u.username, 'wang_fang'); assert.equal(u.name, '王芳'); assert.equal(u.phone, ''); assert.equal(u.active, true);
    assert.equal(typeof u.created_at, 'string'); assert.ok(!('password' in u));
    ids.wang = u.id;
    assert.ok(!JSON.stringify(await get('/api/users?page_size=100')).includes('secret12'));
  });
  await check('用户名重复（大小写不同也算）409；用户名格式、密码长度、角色、姓名不对 400', async () => {
    fail(await req('POST', '/api/users', { username: 'WANG_FANG', password: 'secret12', name: 'x', role: 'sales' }), 409);
    fail(await req('POST', '/api/users', { username: 'ab', password: 'secret12', name: 'x', role: 'sales' }), 400);
    fail(await req('POST', '/api/users', { username: 'bad name', password: 'secret12', name: 'x', role: 'sales' }), 400);
    fail(await req('POST', '/api/users', { username: 'okname', password: '12345', name: 'x', role: 'sales' }), 400);
    fail(await req('POST', '/api/users', { username: 'okname', password: 'secret12', name: 'x', role: 'boss' }), 400);
    fail(await req('POST', '/api/users', { username: 'okname', password: 'secret12', name: '   ', role: 'sales' }), 400);
    fail(await req('POST', '/api/users', { username: 'okname', password: 'secret12', name: 'x', role: 'sales', phone: 'abc' }), 400);
  });
  await check('PATCH 用户：username 忽略，name 可改', async () => {
    const u = await patch(`/api/users/${ids.wang}`, { username: 'other_name', name: '王芳芳' });
    assert.equal(u.username, 'wang_fang'); assert.equal(u.name, '王芳芳');
  });
  await check('用户列表分页结构；role、active、q（不区分大小写）筛选；参数不对 400', async () => {
    const r = await get('/api/users?role=sales&q=WANG');
    assert.equal(r.page, 1); assert.equal(r.page_size, 20);
    assert.ok(r.items.some((u) => u.id === ids.wang)); assert.ok(r.items.every((u) => u.role === 'sales'));
    assert.ok((await list('/api/users?active=false')).every((u) => u.active === false));
    fail(await req('GET', '/api/users?active=yes'), 400);
    fail(await req('GET', '/api/users?role=boss'), 400);
    fail(await req('GET', '/api/users?page_size=101'), 400);
    fail(await req('GET', '/api/users?page=0'), 400);
    const p2 = await get('/api/users?page=2&page_size=1');
    assert.equal(p2.items.length, 1); assert.equal(p2.page, 2); assert.equal(p2.page_size, 1);
  });
  await check('非 admin 不能用用户管理 403（角色检查在对象是否存在之前）；没登录先 401', async () => {
    const s = await fx.user('academic');
    fail(await req('GET', '/api/users', undefined, { as: s.token }), 403);
    fail(await req('GET', '/api/users/99999', undefined, { as: s.token }), 403);
    fail(await req('GET', '/api/users/99999', undefined, { as: null }), 401);
    fail(await req('GET', '/api/users/99999'), 404);
  });
  await check('不能停用、删除自己，不能改自己的角色 409', async () => {
    const me = await get('/api/auth/me');
    fail(await req('PATCH', `/api/users/${me.id}`, { active: false }), 409);
    fail(await req('PATCH', `/api/users/${me.id}`, { role: 'sales' }), 409);
    fail(await req('DELETE', `/api/users/${me.id}`), 409);
  });
  await check('停用用户：已有令牌立即失效，也不能再登录', async () => {
    const u = await fx.user('finance');
    await patch(`/api/users/${u.user.id}`, { active: false });
    fail(await req('GET', '/api/auth/me', undefined, { as: u.token }), 401);
    fail(await req('POST', '/api/auth/login', { username: u.user.username, password: u.password }, { as: null }), 401);
  });
  await check('管理员改了用户的密码，这个用户的全部令牌失效', async () => {
    const u = await fx.user('finance');
    await patch(`/api/users/${u.user.id}`, { password: 'changed99' });
    fail(await req('GET', '/api/auth/me', undefined, { as: u.token }), 401);
    await login(u.user.username, 'changed99');
  });
  await check('删除用户 204，之后 404', async () => {
    const u = await fx.user('sales');
    await del(`/api/users/${u.user.id}`);
    fail(await req('GET', `/api/users/${u.user.id}`), 404);
  });

  group('一期·校区与教室');
  await check('校区：code 存为大写，默认 address ""、phone ""、active true', async () => {
    const c = await post('/api/campuses', { code: 'dh01', name: '东湖校区' });
    assert.equal(c.code, 'DH01'); assert.equal(c.address, ''); assert.equal(c.phone, ''); assert.equal(c.active, true);
    ids.dh = c.id;
  });
  await check('校区 code 重复（大小写不同）、name 重复（不区分大小写）409；code 有非字母数字 400', async () => {
    await post('/api/campuses', { code: 'GG01', name: 'Optics Valley' });
    fail(await req('POST', '/api/campuses', { code: 'DH01', name: '别的校区' }), 409);
    fail(await req('POST', '/api/campuses', { code: 'XX9', name: 'optics valley' }), 409);
    fail(await req('POST', '/api/campuses', { code: 'A-1', name: '新校区' }), 400);
    fail(await req('POST', '/api/campuses', { code: '', name: '新校区' }), 400);
  });
  await check('校区：teacher 能读、不能写；parent 不能读 403', async () => {
    const t = await fx.user('teacher');
    ok(await req('GET', '/api/campuses', undefined, { as: t.token }));
    fail(await req('POST', '/api/campuses', { code: 'T1', name: '教师建的' }, { as: t.token }), 403);
    const p = await fx.user('parent');
    fail(await req('GET', '/api/campuses', undefined, { as: p.token }), 403);
  });
  await check('教室：带 campus_name；同校区重名（不区分大小写）409，别的校区可以同名；容量与校区校验 400', async () => {
    const r = await post('/api/rooms', { campus_id: ids.dh, name: 'A101', capacity: 20 });
    assert.equal(r.campus_name, '东湖校区'); assert.equal(r.active, true); ids.a101 = r.id;
    fail(await req('POST', '/api/rooms', { campus_id: ids.dh, name: 'a101', capacity: 20 }), 409);
    const gg = (await list('/api/campuses?page_size=100')).find((c) => c.code === 'GG01');
    ids.gg = gg.id;
    await post('/api/rooms', { campus_id: gg.id, name: 'A101', capacity: 20 });
    fail(await req('POST', '/api/rooms', { campus_id: ids.dh, name: 'B1', capacity: 0 }), 400);
    fail(await req('POST', '/api/rooms', { campus_id: ids.dh, name: 'B1', capacity: 201 }), 400);
    fail(await req('POST', '/api/rooms', { campus_id: 99999, name: 'B1', capacity: 10 }), 400);
  });
  await check('教室 PATCH 里的 campus_id 忽略；GET /api/rooms 按 campus_id 筛选', async () => {
    const r = await patch(`/api/rooms/${ids.a101}`, { campus_id: ids.gg, capacity: 25 });
    assert.equal(r.campus_id, ids.dh); assert.equal(r.capacity, 25);
    const rooms = await list(`/api/rooms?campus_id=${ids.dh}`);
    assert.deepEqual(pluck(rooms, 'campus_id').filter((x) => x !== ids.dh), []);
    assert.ok(rooms.some((x) => x.id === ids.a101));
  });
  await check('停用的校区不能用于新教室 400；有教室的校区不能删 409；空校区可以删 204', async () => {
    const c = await fx.campus();
    await fx.room(c.id);
    await patch(`/api/campuses/${c.id}`, { active: false });
    fail(await req('POST', '/api/rooms', { campus_id: c.id, name: 'Z1', capacity: 10 }), 400);
    fail(await req('DELETE', `/api/campuses/${c.id}`), 409);
    const empty = await fx.campus();
    await del(`/api/campuses/${empty.id}`);
    assert.ok((await list('/api/campuses?active=false&page_size=100')).every((x) => x.active === false));
  });

  group('一期·科目与课程');
  await check('科目重名（不区分大小写）409', async () => {
    ids.math = (await post('/api/subjects', { name: 'Math' })).id;
    fail(await req('POST', '/api/subjects', { name: 'math' }), 409);
  });
  await check('课程：code 存为大写，带 subject_name，默认 description ""、active true', async () => {
    const c = await post('/api/courses', { code: 'ma-g4', name: '四年级数学', subject_id: ids.math, type: 'group', lesson_minutes: 90, price_per_lesson: 15000, default_lessons: 20, max_students: 20, grade_min: 4, grade_max: 4 });
    assert.equal(c.code, 'MA-G4'); assert.equal(c.subject_name, 'Math'); assert.equal(c.description, ''); assert.equal(c.active, true);
    ids.ma4 = c.id;
  });
  await check('课程校验：分钟数不是 5 的倍数或越界、人数与类型不匹配、年级反了 400；code 重复 409', async () => {
    const base = { code: 'X-1', name: 'x', subject_id: ids.math, type: 'group', lesson_minutes: 60, price_per_lesson: 100, default_lessons: 10, max_students: 10, grade_min: 1, grade_max: 6 };
    for (const bad of [{ lesson_minutes: 47 }, { lesson_minutes: 25 }, { lesson_minutes: 245 }, { type: 'one_on_one', max_students: 2 }, { max_students: 1 }, { max_students: 61 }, { grade_min: 7, grade_max: 6 }, { grade_max: 13 }, { subject_id: 99999 }, { type: 'vip' }]) {
      fail(await req('POST', '/api/courses', { ...base, ...bad }), 400);
    }
    ok(await req('POST', '/api/courses', { ...base, code: 'X-2', type: 'one_on_one', max_students: 1 }), 201);
    fail(await req('POST', '/api/courses', { ...base, code: 'ma-G4' }), 409);
  });
  await check('停用的科目不能用于新课程 400；被课程用到的科目不能删 409', async () => {
    const s = await fx.subject();
    await fx.course(s.id);
    fail(await req('DELETE', `/api/subjects/${s.id}`), 409);
    const s2 = await fx.subject();
    await patch(`/api/subjects/${s2.id}`, { active: false });
    fail(await req('POST', '/api/courses', { code: 'X-3', name: 'x', subject_id: s2.id, type: 'group', lesson_minutes: 60, price_per_lesson: 100, default_lessons: 10, max_students: 10, grade_min: 1, grade_max: 6 }), 400);
  });
  await check('课程列表筛选：type、grade、q（code 或 name，不区分大小写）、subject_id', async () => {
    assert.ok((await list('/api/courses?type=one_on_one&page_size=100')).every((c) => c.type === 'one_on_one'));
    const g4 = await list('/api/courses?grade=4&page_size=100');
    assert.ok(g4.some((c) => c.id === ids.ma4)); assert.ok(g4.every((c) => c.grade_min <= 4 && c.grade_max >= 4));
    assert.ok(!(await list('/api/courses?grade=5&page_size=100')).some((c) => c.id === ids.ma4));
    assert.ok((await list('/api/courses?q=ma-g&page_size=100')).some((c) => c.id === ids.ma4));
    assert.ok((await list(`/api/courses?subject_id=${ids.math}&page_size=100`)).every((c) => c.subject_id === ids.math));
  });
  await check('academic 能改课程，sales 只能读 403', async () => {
    const a = await fx.user('academic');
    assert.equal((await patch(`/api/courses/${ids.ma4}`, { description: '提高班' }, a.token)).description, '提高班');
    const s = await fx.user('sales');
    ok(await req('GET', `/api/courses/${ids.ma4}`, undefined, { as: s.token }));
    fail(await req('PATCH', `/api/courses/${ids.ma4}`, { name: 'x' }, { as: s.token }), 403);
  });

  group('一期·学期与节假日');
  await check('学期：结束早于开始 400；日期范围重叠（含端点）409；按 start_date 升序', async () => {
    await post('/api/terms', { name: '2031 秋季', start_date: '2031-09-01', end_date: '2032-01-20' });
    await post('/api/terms', { name: '2031 春季', start_date: '2031-02-20', end_date: '2031-06-30' });
    fail(await req('POST', '/api/terms', { name: '反了', start_date: '2031-07-10', end_date: '2031-07-01' }), 400);
    fail(await req('POST', '/api/terms', { name: '端点重叠', start_date: '2031-06-30', end_date: '2031-08-01' }), 409);
    fail(await req('POST', '/api/terms', { name: '2031 秋季', start_date: '2033-01-01', end_date: '2033-02-01' }), 409);
    const terms = await get('/api/terms');
    const ours = terms.filter((t) => t.name.startsWith('2031'));
    assert.deepEqual(pluck(ours, 'name'), ['2031 春季', '2031 秋季']);
  });
  await check('节假日：日期重复 409，不存在的日期 400；from/to 含两端，按日期升序', async () => {
    await post('/api/holidays', { date: '2031-10-03', name: '国庆' });
    await post('/api/holidays', { date: '2031-10-01', name: '国庆' });
    await post('/api/holidays', { date: '2031-10-05', name: '国庆' });
    fail(await req('POST', '/api/holidays', { date: '2031-10-01', name: '重复' }), 409);
    fail(await req('POST', '/api/holidays', { date: '2031-02-30', name: '不存在' }), 400);
    const h = await get('/api/holidays?from=2031-10-01&to=2031-10-03');
    assert.deepEqual(pluck(h, 'date'), ['2031-10-01', '2031-10-03']);
  });

  group('一期·教师与可上课时间');
  await check('教师：绑定 teacher 用户，带 campus_name 与 subject_names；那个用户的 me.teacher_id 是档案编号', async () => {
    const u = await fx.user('teacher');
    const eng = await post('/api/subjects', { name: '英语' });
    const t = await post('/api/teachers', { user_id: u.user.id, name: '李老师', campus_id: ids.dh, subject_ids: [eng.id, ids.math], employment: 'part_time' });
    assert.equal(t.campus_name, '东湖校区'); assert.deepEqual(t.subject_names, ['英语', 'Math']); assert.equal(t.pay_per_lesson, 0); assert.equal(t.active, true);
    assert.equal((await get('/api/auth/me', u.token)).teacher_id, t.id);
    Object.assign(ids, { t1: t.id, t1user: u.user.id, t1token: u.token, eng: eng.id });
  });
  await check('教师校验：用户不是 teacher 角色或不存在 400，同一用户绑两个档案 409，科目为空、超过 5 个或重复 400', async () => {
    const base = { name: '王老师', campus_id: ids.dh, subject_ids: [ids.math], employment: 'full_time' };
    fail(await req('POST', '/api/teachers', { ...base, user_id: ids.wang }), 400);
    fail(await req('POST', '/api/teachers', { ...base, user_id: 99999 }), 400);
    fail(await req('POST', '/api/teachers', { ...base, user_id: ids.t1user }), 409);
    fail(await req('POST', '/api/teachers', { ...base, subject_ids: [] }), 400);
    fail(await req('POST', '/api/teachers', { ...base, subject_ids: [ids.math, ids.math] }), 400);
    const six = [];
    for (let i = 0; i < 6; i++) six.push((await fx.subject()).id);
    fail(await req('POST', '/api/teachers', { ...base, subject_ids: six }), 400);
    fail(await req('POST', '/api/teachers', { ...base, employment: 'intern' }), 400);
  });
  await check('教师列表：subject_id（能教这个科目的）、q（姓名）筛选', async () => {
    ids.t2 = (await post('/api/teachers', { user_id: null, name: '赵老师', campus_id: ids.gg, subject_ids: [ids.eng], employment: 'full_time' })).id;
    const bySubject = await list(`/api/teachers?subject_id=${ids.math}&page_size=100`);
    assert.ok(bySubject.some((t) => t.id === ids.t1)); assert.ok(!bySubject.some((t) => t.id === ids.t2));
    const byName = await list(`/api/teachers?q=${encodeURIComponent('赵')}&page_size=100`);
    assert.ok(byName.some((t) => t.id === ids.t2)); assert.ok(!byName.some((t) => t.id === ids.t1));
  });
  await check('绑定了教师档案的用户不能删除、不能改角色 409', async () => {
    fail(await req('DELETE', `/api/users/${ids.t1user}`), 409);
    fail(await req('PATCH', `/api/users/${ids.t1user}`, { role: 'sales' }), 409);
  });
  await check('可上课时间：初始为空；PUT 整体替换，结果按 weekday、start 升序；首尾相接不算重叠', async () => {
    assert.deepEqual(await get(`/api/teachers/${ids.t1}/availability`), []);
    const r = await put(`/api/teachers/${ids.t1}/availability`, { slots: [{ weekday: 3, start: '18:00', end: '21:00' }, { weekday: 1, start: '14:00', end: '16:00' }, { weekday: 1, start: '08:00', end: '14:00' }] });
    assert.deepEqual(r, [{ weekday: 1, start: '08:00', end: '14:00' }, { weekday: 1, start: '14:00', end: '16:00' }, { weekday: 3, start: '18:00', end: '21:00' }]);
    assert.deepEqual(await get(`/api/teachers/${ids.t1}/availability`), r);
  });
  await check('可上课时间校验：start 不早于 end、同一天重叠、weekday 越界、超过 30 条都是 400', async () => {
    const u = `/api/teachers/${ids.t1}/availability`;
    fail(await req('PUT', u, { slots: [{ weekday: 2, start: '10:00', end: '10:00' }] }), 400);
    fail(await req('PUT', u, { slots: [{ weekday: 2, start: '10:00', end: '12:00' }, { weekday: 2, start: '11:59', end: '13:00' }] }), 400);
    fail(await req('PUT', u, { slots: [{ weekday: 8, start: '10:00', end: '12:00' }] }), 400);
    fail(await req('PUT', u, { slots: [{ weekday: 2, start: '9:00', end: '12:00' }] }), 400);
    const many = Array.from({ length: 31 }, (_, i) => ({ weekday: (i % 7) + 1, start: `${String(Math.floor(i / 7) * 2 + 6).padStart(2, '0')}:00`, end: `${String(Math.floor(i / 7) * 2 + 7).padStart(2, '0')}:00` }));
    fail(await req('PUT', u, { slots: many }), 400);
    assert.equal((await get(u)).length, 3, '失败的 PUT 不应改动原来的时段');
  });
  await check('teacher 能改自己的可上课时间、能读别人的，改别人的 403；finance 读 403', async () => {
    ok(await req('PUT', `/api/teachers/${ids.t1}/availability`, { slots: [] }, { as: ids.t1token }));
    ok(await req('GET', `/api/teachers/${ids.t2}/availability`, undefined, { as: ids.t1token }));
    fail(await req('PUT', `/api/teachers/${ids.t2}/availability`, { slots: [] }, { as: ids.t1token }), 403);
    const f = await fx.user('finance');
    fail(await req('GET', `/api/teachers/${ids.t1}/availability`, undefined, { as: f.token }), 403);
  });
  await check('停用的科目不能用于教师 400；被教师用到的科目不能删 409', async () => {
    fail(await req('DELETE', `/api/subjects/${ids.eng}`), 409);
    const s = await fx.subject();
    await patch(`/api/subjects/${s.id}`, { active: false });
    fail(await req('POST', '/api/teachers', { name: '钱老师', campus_id: ids.dh, subject_ids: [s.id], employment: 'full_time' }), 400);
  });
}
