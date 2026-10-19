# 小树培训学校教务系统（edu）

## 概述

给一家有 2～5 个校区的课外培训学校用的教务系统。课程顾问跟进线索、安排试听、给学员报名收费；教务开班排课、点名消课、处理请假、补课与调课；财务审批退费、确认收入、给教师算课酬；教师布置作业、录成绩、写课堂反馈；家长在家长端看课表、请假、交作业、看成绩与通知。
有网页界面（原型见 `docs/prototype/`，打开 `docs/prototype/index.html`），后端提供 JSON API，页面通过 API 工作。

## 分期

**分五期交付**，每一期都要有对应的页面（见"页面"一节的"期"列）：

- 第一期：服务、登录、用户与权限、基础资料（REQ-001–REQ-011）。
- 第二期：学员、家长、招生线索与报名收费（REQ-012–REQ-020）。
- 第三期：班级、排课、点名消课、请假与补课（REQ-021–REQ-030）。
- 第四期：退费、转课、余额、收款流水、收入确认与教师课酬（REQ-031–REQ-037）。
- 第五期：作业、成绩、课堂反馈、家长端、通知、公告、报表、导出与操作日志（REQ-038–REQ-050）。

## 用户与角色

| 角色 | 是谁 | 主要工作 |
|---|---|---|
| `admin` | 校长、系统管理员 | 全部功能，包括用户管理与操作日志 |
| `academic` | 教务 | 基础资料、班级排课、分班、点名更正、请假审批、补课、作业与成绩 |
| `sales` | 课程顾问 | 线索、跟进、试听、学员、报名收费、发起退费与转课 |
| `finance` | 财务 | 优惠、收款流水、退费审批、余额取现、收入确认、课酬与工资单 |
| `teacher` | 教师 | 自己的课表、点名、作业、成绩、课堂反馈、自己的课酬 |
| `parent` | 家长 | 只用家长端：自己孩子的课表、课时、请假、作业、成绩、反馈、通知 |

### 权限表

"读写"是能查看和修改，"读"是只能查看，"自己的"见 REQ-004 AC2，"—"是不能用（403）。表里没有列出的接口按它所属的功能算。

| 功能 | admin | academic | sales | finance | teacher | parent |
|---|---|---|---|---|---|---|
| 用户（REQ-003）、操作日志（REQ-049） | 读写 | — | — | — | — | — |
| 选择用户（REQ-003 AC6） | 读 | 读 | 读 | — | — | — |
| 校区（REQ-005） | 读写 | 读 | 读 | 读 | 读 | — |
| 教室、科目、课程、学期与节假日（REQ-006–REQ-009） | 读写 | 读写 | 读 | 读 | 读 | — |
| 教师（REQ-010） | 读写 | 读写 | 读 | 读 | 读 | — |
| 教师可上课时间（REQ-011） | 读写 | 读写 | 读 | — | 读；写自己的 | — |
| 学员、家长绑定（REQ-012、REQ-013） | 读写 | 读写 | 读写 | 读 | 自己的（读） | 自己的（读） |
| 线索、跟进、试听、转化（REQ-014–REQ-017） | 读写 | — | 自己的（读写） | — | — | — |
| 优惠（REQ-018） | 读写 | — | 读 | 读写 | — | — |
| 订单与收据（REQ-019） | 读写 | 读 | 读写 | 读 | — | — |
| 课时包、课时账户与流水（REQ-020） | 读 | 读 | 读 | 读 | — | 自己的（读） |
| 班级、发布、结课与取消（REQ-021、REQ-022、REQ-029） | 读写 | 读写 | 读 | 读 | 自己的（读） | — |
| 课次（REQ-023） | 读 | 读 | 读 | 读 | 自己的（读） | — |
| 调课、代课、停课（REQ-024） | 读写 | 读写 | — | — | — | — |
| 分班（REQ-025） | 读写 | 读写 | 读 | 读 | 自己的（读） | — |
| 点名（REQ-026 的 POST、GET） | 读写 | 读写 | — | — | 自己的（读写） | — |
| 点名更正（REQ-026 的 PUT） | 读写 | 读写 | — | — | — | — |
| 请假（REQ-027）：创建与取消 | 读写 | 读写 | 读写 | — | — | 自己的（读写） |
| 请假：批准与驳回 | 读写 | 读写 | — | — | — | — |
| 请假：查看 | 读 | 读 | 读 | — | 自己的（读） | 自己的（读） |
| 补课（REQ-028） | 读写 | 读写 | — | — | — | — |
| 学员考勤（REQ-030） | 读 | 读 | 读 | — | 自己的（读） | 自己的（读） |
| 退费：创建（REQ-031） | 读写 | — | 读写 | 读 | — | — |
| 退费：批准与驳回 | 读写 | — | — | 读写 | — | — |
| 转课（REQ-032） | 读写 | 读 | 读写 | 读 | — | — |
| 学员余额（REQ-033）：查看 | 读 | — | 读 | 读 | — | 自己的（读） |
| 学员余额：取现 | 读写 | — | — | 读写 | — | — |
| 收款流水与汇总（REQ-034）、收入确认（REQ-035） | 读 | — | — | 读 | — | — |
| 课酬标准、工资单（REQ-036、REQ-037） | 读写 | — | — | 读写 | 自己的（读，只有 `/api/payrolls/mine`） | — |
| 作业、考试与成绩、课堂反馈（REQ-038–REQ-041） | 读写 | 读写 | 读 | — | 自己的（读写） | 见 REQ-039、REQ-042 |
| 家长端（REQ-042） | — | — | — | — | — | 自己的（读） |
| 站内通知（REQ-043） | 自己的 | 自己的 | 自己的 | 自己的 | 自己的 | 自己的 |
| 公告（REQ-044）：管理 | 读写 | 读写 | — | — | — | — |
| 看板（REQ-045） | 读 | 读 | 读 | 读 | — | — |
| 招生报表（REQ-046） | 读 | — | 读 | — | — | — |
| 消课与出勤报表、余额预警（REQ-047） | 见 REQ-047 |  |  |  |  |  |
| 导出（REQ-048） | 见 REQ-048 |  |  |  |  |  |

## 通用约定

- API 都在 `/api/` 下。请求与响应都是 JSON，响应头 `Content-Type: application/json`（导出接口除外）。
- 成功：创建返回 `201` 与新对象；查询返回 `200`；修改（PATCH、PUT）和各种操作（`/approve`、`/pay` 这类）返回 `200` 与修改后的对象，另有说明的除外；删除返回 `204`，没有响应体。
- 失败统一返回 `{"error": {"code": "<代码>", "message": "<中文说明>"}}`：
  - `invalid_json`（400）：请求体不是合法 JSON，或不是 JSON 对象。
  - `validation_failed`（400）：字段缺失、类型或取值不对、查询参数不合法、引用的对象不存在。
  - `unauthorized`（401）：没有登录、令牌无效或已退出、用户名密码不对、用户已停用。
  - `forbidden`（403）：角色没有权限，或记录不在自己的范围内（REQ-004）。
  - `not_found`（404）：路径里的对象不存在（包括路径里的编号不是正整数）；没有这个 API 路径或方法（不用 405）。
  - `conflict`（409）：违反唯一性、状态不允许这个操作、时间冲突、余额或名额不足，或删除仍被引用的对象。
- 检查顺序：先检查登录（401），再检查角色权限（403），再检查路径里的对象是否存在（404），再检查记录范围（403），最后校验请求（400、409）。
- 编号 `id` 是正整数，每种资源各自从 1 递增，删除后不复用。单号（`S000001`、`OD000001` 这类）的序号同样各自递增、不复用。
- **列表与分页**：路径只有一段资源名的列表接口（例如 `GET /api/students`、`GET /api/orders`）分页，查询参数 `page`（默认 1）、`page_size`（默认 20，最大 100），不合法 → 400；返回 `{"items": [...], "total": <符合条件的总数>, "page", "page_size"}`。其他列表（子资源如 `GET /api/students/:id/guardians`，以及另有说明的 `GET /api/lessons`、报表）直接返回数组或说明里的对象。没有说明排序的列表按 `id` 升序。
- 下拉框要全部选项时用 `page_size=100` 取，超过 100 条再逐页取完。
- **名称字段**：响应里引用学员、教师、课程、班级、校区、教室、学期、科目、优惠、用户的编号字段，另带这个对象的名称，名称字段把 `_id` 换成 `_name`（`teacher_id` → `teacher_name`、`term_id` → `term_name`、`original_teacher_id` → `original_teacher_name`）；用户编号 `created_by`、`reviewed_by`、`submitted_by`、`graded_by`、`user_id` 另带 `created_by_name` 这样的用户姓名（`user_id` → `user_name`）。编号为 `null` 时名称也是 `null`。各需求里写的"另带 …_name"是这条的例子，没写的也要带；字段表里已经有名称的（例如家长绑定的 `name`）不用重复。
- **中文名**：页面上的状态、类型等取值显示中文，取值后面写了中文的照写（例如 `active` 开课），角色的中文名是：`admin` 管理员、`academic` 教务、`sales` 课程顾问、`finance` 财务、`teacher` 教师、`parent` 家长。
- 金额一律是**整数，单位是分**。
- **时区**：学校在北京时间（Asia/Shanghai）。"今天"、"本月"、日期筛选、"课次开始时间"都按北京时间；`created_at` 这类时间戳是 ISO 8601 的 UTC 时间字符串（例如 `2026-10-15T08:30:00.000Z`）。
- 日期范围参数 `from`、`to`（含两端）都给了而 `from` 晚于 `to` → 400；按 `created_at` 筛选的日期范围指 `created_at` 的北京日期。
- 日期是 `YYYY-MM-DD`（必须是真实存在的日期）；时刻是 `HH:MM`（24 小时制，两位数）；月份是 `YYYY-MM`；星期 `weekday` 是 1–7，1 是星期一。
- 创建时可以省略的字段：写了默认值的取默认值，可以为 `null` 的默认 `null`；其余字段必填，缺了 → 400。
- 字符串字段先去掉首尾空白，再校验长度并保存；必填的字符串去掉空白后为空 → 400。请求体里多余的字段忽略；只读字段（`id`、各种 `no`、`status`、金额合计、时间戳）在请求里给了也忽略（需求里写明可以修改的除外，例如学员的 `status`）。
- 基础资料与带 `PATCH` 的资源：`PATCH /:id` 只改请求里给出的字段，校验同创建。`GET /:id` 返回的对象与列表里的一项相同，另有说明的除外。
- 布尔查询参数只能是 `true` 或 `false`，否则 400。
- 手机号字段（`phone`）：0–20 个字符，只能有数字、空格、`-`、`+`。

# 第一期：服务、登录与基础资料

## 服务启动、数据库与健康检查  REQ-001

- AC1 仓库根目录有 `docker-compose.yml`，其中服务 `db` 是 PostgreSQL 16：用户 `edu`、密码 `edu`、数据库 `edu`，容器的 5432 端口映射到本机端口 `${DB_PORT:-5432}`，数据放在命名卷里，配置了健康检查；`docker compose up -d --wait db` 能把它启动到健康状态。不写死 `container_name`：同一台机器上可以用 `docker compose -p <名称>` 加不同的 `DB_PORT` 同时起几份互不影响。
- AC2 `./setup.sh` 安装后端与前端的依赖并构建前端，可以重复执行；`./run.sh` 在前台启动服务：监听环境变量 `PORT`（默认 8000），连接环境变量 `DATABASE_URL` 指定的数据库（默认 `postgresql://edu:edu@localhost:5432/edu`）。需要的工具见 `docs/ARCHITECTURE.md`。
- AC3 服务启动时自动建表或执行迁移：空数据库和已有数据的数据库都能直接启动；重启后数据、编号与各种单号的计数都保留。
- AC4 同一个进程提供 `/api/` 下的接口和前端页面：页面路径（见"页面"一节）在浏览器里直接打开或刷新都返回页面；`/api/` 下不存在的路径返回 404 `not_found`（JSON）。
- AC5 `GET /api/health` 返回 `200 {"ok": true}`，不需要登录。
- AC6 第一次启动、还没有任何用户时，自动创建管理员：用户名 `admin`，密码 `admin123`，姓名 `管理员`，角色 `admin`。

## 登录、退出与当前用户  REQ-002

- AC1 `POST /api/auth/login`，请求体 `{"username", "password"}`（用户名不区分大小写）：成功返回 `200 {"token": "<字符串>", "user": <当前用户>}`；用户名或密码不对、用户已停用 → 401。
- AC2 除 `GET /api/health` 和 `POST /api/auth/login` 外，所有接口都要在请求头带 `Authorization: Bearer <token>`；没有令牌、令牌无效或已失效 → 401。
- AC3 `POST /api/auth/logout` 返回 204，这个令牌之后无效。
- AC4 `GET /api/auth/me` 返回当前用户 `{"id", "username", "name", "role", "teacher_id", "student_ids"}`：`teacher_id` 是绑定的教师档案编号（不是教师或没有绑定时为 `null`）；`student_ids` 是家长绑定的学员编号（升序，不是家长时为 `[]`）。登录返回的 `user` 是同样的结构。
- AC5 `POST /api/auth/password`，请求体 `{"old_password", "new_password"}`：旧密码不对 → 400；新密码不是 6–64 个字符 → 400；成功返回 204，这个用户的其他令牌全部失效，当前令牌仍然有效。

## 用户管理 `/api/users`  REQ-003

- AC1 字段：`id`、`username`（3–32 个字符，只能是字母、数字和下划线，保存为小写，唯一）、`name`（1–30 个字符）、`role`（`admin` | `academic` | `sales` | `finance` | `teacher` | `parent`）、`phone`（默认 `""`）、`active`（布尔，默认 `true`）、`created_at`。创建时必须给 `password`（6–64 个字符）；任何响应都不返回密码。
- AC2 `username` 重复 → 409。`username` 创建后不能改（PATCH 里给了也忽略）；PATCH 可以改 `name`、`role`、`phone`、`active`、`password`，改了密码后这个用户的全部令牌失效。
- AC3 停用的用户不能登录（401），已有的令牌立即失效。
- AC4 不能停用、删除自己，也不能改自己的角色 → 409。绑定了教师档案或学员的用户不能删除 → 409（可以停用）；绑定了教师档案的用户不能改成别的角色，绑定了学员的家长也不能改成别的角色 → 409。
- AC5 `GET /api/users` 可选查询参数：`role`、`active`、`q`（`username` 或 `name` 包含它，不区分大小写）；参数取值不对 → 400。
- AC6 `GET /api/users/options`（给绑定教师档案、绑定家长、选负责顾问用），必须给 `role`，可选 `q`（同 AC5）：返回启用的这个角色的用户 `[{"id", "username", "name", "phone"}]`，按 `id` 升序，最多 20 条，不分页。

## 角色权限  REQ-004

- AC1 每个接口按"用户与角色"一节的权限表检查角色，没有权限 → 403。
- AC2 记录范围（权限表里的"自己的"）：`sales` 只能看到和操作自己负责的线索（`owner_id` 是自己）以及这些线索的跟进与试听；`teacher` 只能看到自己的班级与课次（`teacher_id` 是自己绑定的教师档案）、这些班级当前与曾经的学员，以及这些学员在这些班级里的数据；`parent` 只能看到自己绑定的学员及其相关数据。列表接口只返回范围内的记录；按编号访问范围外的记录 → 403。
- AC3 没有绑定教师档案的 `teacher` 用户：自己范围内的列表为空，按编号访问 → 403。
- AC4 修改类操作要求记录在范围内：例如 `teacher` 给别人的课次点名 → 403，`parent` 给别人的孩子请假 → 403。

## 校区 `/api/campuses`  REQ-005

- AC1 字段：`id`、`code`（1–10 个字符，只能是字母和数字，保存为大写，唯一）、`name`（1–30 个字符，不区分大小写唯一）、`address`（0–100 个字符，默认 `""`）、`phone`（默认 `""`）、`active`（默认 `true`）。
- AC2 `code` 或 `name` 重复 → 409。
- AC3 有教室、教师、学员、线索或班级的校区不能删除 → 409（可以停用）。
- AC4 停用的校区不能用在新建或修改的教室、教师、学员、线索、试听、班级里 → 400。
- AC5 `GET /api/campuses` 可选查询参数 `active`。

## 教室 `/api/rooms`  REQ-006

- AC1 字段：`id`、`campus_id`、`name`（1–20 个字符，同一校区内不区分大小写唯一）、`capacity`（1–200 的整数）、`active`（默认 `true`）；列表与详情另带 `campus_name`。
- AC2 同一校区内 `name` 重复 → 409；`campus_id` 不存在 → 400。`campus_id` 创建后不能改（PATCH 里给了也忽略）。
- AC3 被任何班级或课次用到的教室不能删除 → 409；停用的教室不能用在新建或修改的班级、调课里 → 400。
- AC4 `GET /api/rooms` 可选查询参数 `campus_id`、`active`。

## 科目 `/api/subjects`  REQ-007

- AC1 字段：`id`、`name`（1–20 个字符，不区分大小写唯一）、`active`（默认 `true`）。
- AC2 `name` 重复 → 409；被课程或教师用到的科目不能删除 → 409；停用的科目不能用在新建或修改的课程、教师里 → 400。

## 课程 `/api/courses`  REQ-008

- AC1 字段：`id`、`code`（1–16 个字符，只能是字母、数字和 `-`，保存为大写，唯一）、`name`（1–40 个字符）、`subject_id`、`type`（`group` 班课 | `one_on_one` 一对一）、`lesson_minutes`（每节课分钟数，30–240 且是 5 的倍数）、`price_per_lesson`（每节课单价，0–10000000）、`default_lessons`（报名时默认的课时数，1–200）、`max_students`（每班最多人数：班课 2–60，一对一必须是 1）、`grade_min`、`grade_max`（适合的年级，1–12，`grade_min ≤ grade_max`）、`description`（0–500 个字符，默认 `""`）、`active`（默认 `true`）；列表与详情另带 `subject_name`。
- AC2 `code` 重复 → 409；`subject_id` 不存在或已停用 → 400；`max_students` 与 `type` 不匹配、`grade_min > grade_max` → 400。
- AC3 `GET /api/courses` 可选查询参数：`subject_id`、`type`、`active`、`grade`（`grade_min ≤ grade ≤ grade_max` 的课程）、`q`（`code` 或 `name` 包含它，不区分大小写）。
- AC4 有班级、订单或试听的课程不能删除 → 409（可以停用）；有班级的课程不能改 `type`、`lesson_minutes` → 409；修改 `price_per_lesson` 只影响之后的订单。
- AC5 停用的课程不能用在新的订单、班级、试听、转课里 → 400。

## 学期与节假日  REQ-009

- AC1 `/api/terms`：字段 `id`、`name`（1–30 个字符，唯一）、`start_date`、`end_date`（`end_date ≥ start_date`，否则 400）。两个学期的日期范围不能重叠（含端点）→ 409；有班级的学期不能删除 → 409。有 `POST`、`PATCH`、`DELETE`；`GET /api/terms` 返回数组（不分页），按 `start_date` 升序。
- AC2 `/api/holidays`：字段 `id`、`date`（唯一）、`name`（1–30 个字符）；`date` 重复 → 409；有 `POST`、`PATCH`、`DELETE`。`GET /api/holidays` 返回数组（不分页），可选查询参数 `from`、`to`（日期，含两端），按 `date` 升序。
- AC3 节假日只影响之后生成或顺延的课次（REQ-022、REQ-024），已经排好的课次不变。

## 教师 `/api/teachers`  REQ-010

- AC1 字段：`id`、`user_id`（`null` 或一个 `teacher` 角色的用户；用户不存在或不是 `teacher` → 400；一个用户只能绑定一个教师档案，重复 → 409）、`name`（1–30 个字符）、`phone`（默认 `""`）、`campus_id`（所属校区）、`subject_ids`（能教的科目编号，1–5 个、不能重复）、`pay_per_lesson`（默认的每节课课酬，0–1000000，默认 0）、`employment`（`full_time` 全职 | `part_time` 兼职）、`active`（默认 `true`）、`created_at`；列表与详情另带 `campus_name`、`subject_names`（与 `subject_ids` 一一对应）。
- AC2 `GET /api/teachers` 可选查询参数：`campus_id`、`subject_id`（能教这个科目的）、`active`、`q`（姓名包含它）。
- AC3 有班级或课次的教师不能删除 → 409（可以停用）；停用的教师不能用在新的班级、代课、试听里 → 400。
- AC4 绑定了用户的教师档案，这个用户就是这位教师：他的 `GET /api/auth/me` 的 `teacher_id` 是这个档案的编号。

## 教师可上课时间 `/api/teachers/:id/availability`  REQ-011

- AC1 `GET` 返回 `[{"weekday", "start", "end"}]`（`start`、`end` 是 `HH:MM`），按 `weekday`、`start` 升序。
- AC2 `PUT`，请求体 `{"slots": [{"weekday", "start", "end"}]}`（0–30 条），整体替换，返回 200 与替换后的列表：`start < end`，否则 400；同一天的时段不能重叠（首尾相接不算重叠），否则 400。
- AC3 `teacher` 只能修改自己的（别人的 → 403）。
- AC4 教师设置了可上课时间时，排给他的课次（发布班级、调课、代课、停课顺延）必须完全落在当天的某一个时段内，否则 409；一条也没有设置时任何时间都可以排。只检查之后排的课次，已经排好的不受影响。

# 第二期：学员、招生与报名收费

## 学员 `/api/students`  REQ-012

- AC1 字段：`id`、`no`（学号，`S` 加 6 位序号，如 `S000001`，自动生成）、`name`（1–30 个字符）、`gender`（`male` | `female` | `unknown`，默认 `unknown`）、`birth_date`（日期或 `null`，不能晚于今天）、`grade`（1–12 或 `null`）、`school`（0–50 个字符，默认 `""`）、`phone`（默认 `""`）、`campus_id`（所属校区，必填）、`status`（`active` 在读 | `inactive` 停读，默认 `active`，可以 PATCH）、`note`（0–500 个字符，默认 `""`）、`created_at`；列表与详情另带 `campus_name`。
- AC2 `GET /api/students` 可选查询参数：`q`（`name`、`no`、`phone` 包含它）、`campus_id`、`grade`、`status`、`class_id`（当前在这个班里的学员）；按 `id` 降序。
- AC3 `GET /api/students/:id` 另外返回 `guardians`（同 REQ-013 AC1 的列表）。
- AC4 有订单、课时包、分班或请假记录的学员不能删除 → 409（可以改为 `inactive`）；`inactive` 的学员不能下单、分班、请假、补课 → 409。

## 家长绑定 `/api/students/:id/guardians`  REQ-013

- AC1 `GET` 返回 `[{"user_id", "name", "phone", "relation"}]`（`name`、`phone` 取家长用户的），按 `user_id` 升序。
- AC2 `POST`，请求体 `{"user_id", "relation"}`（`relation` 是 `father` 父亲 | `mother` 母亲 | `other` 其他）：用户不存在、已停用或不是 `parent` 角色 → 400；已经绑定 → 409；这个学员已有 4 个家长 → 409；成功返回 201 与这一条。
- AC3 `DELETE /api/students/:id/guardians/:user_id` 返回 204；没有这个绑定 → 404。
- AC4 绑定后家长的 `GET /api/auth/me` 的 `student_ids` 包含这个学员；解绑后家长立即看不到这个学员的任何数据（403）。一个家长可以绑定多个学员。

## 线索 `/api/leads`  REQ-014

- AC1 字段：`id`、`name`（1–30 个字符）、`phone`（5–20 个字符，必填）、`grade`（1–12 或 `null`）、`source`（`walk_in` 到访 | `referral` 转介绍 | `online` 网络 | `event` 活动 | `other` 其他）、`interest_course_id`（课程编号或 `null`）、`campus_id`、`owner_id`（负责的顾问：启用的 `sales` 或 `admin` 用户，否则 400；不给时是创建人；`sales` 创建与修改时给的 `owner_id` 忽略，总是自己）、`status`、`next_follow_up`（日期或 `null`）、`student_id`（转化后的学员编号，之前为 `null`）、`lost_reason`（流失原因，默认 `""`）、`note`（0–500 个字符，默认 `""`）、`created_at`；列表与详情另带 `owner_name`。
- AC2 `status`：`new` 新建 → `contacted` 已联系 → `trial_scheduled` 已约试听 → `trialed` 已试听 → `converted` 已转化；没有结束（不是 `converted`、`lost`）的线索可以 → `lost` 流失。`status` 只由跟进、试听、转化、流失改变，PATCH 里给了也忽略；没有结束的线索在任何状态下都可以跟进、约试听、转化、流失（不要求按顺序走完）。
- AC3 同一个手机号（去掉空格、`-`、`+` 后比较）只能有一条没有结束的线索，创建与修改时都检查 → 409。
- AC4 `GET /api/leads` 可选查询参数：`status`、`source`、`owner_id`（`sales` 用这个参数无效，总是只看自己的）、`campus_id`、`q`（姓名或手机号包含它）、`follow_up_before`（`next_follow_up` 不晚于这个日期的）；按 `id` 降序。
- AC5 `POST /api/leads/:id/lose`，请求体 `{"reason"}`（1–200 个字符）：→ `lost`，记 `lost_reason`；已结束的线索 → 409。
- AC6 已结束的线索不能 PATCH → 409；有跟进或试听记录的线索不能删除 → 409。

## 跟进记录 `/api/leads/:id/follow-ups`  REQ-015

- AC1 `POST`，请求体 `{"method", "content", "next_follow_up"}`（`method` 是 `phone` 电话 | `wechat` 微信 | `visit` 面谈 | `other` 其他；`content` 1–500 个字符；`next_follow_up` 是今天或以后的日期，或 `null`）：返回 201 `{"id", "lead_id", "method", "content", "next_follow_up", "created_by", "created_by_name", "created_at"}`。
- AC2 同时把线索的 `next_follow_up` 改成这一条的值；线索是 `new` 时改为 `contacted`。
- AC3 `GET` 按 `id` 降序；已结束的线索不能再加跟进 → 409。

## 试听 `/api/trials`  REQ-016

- AC1 字段：`id`、`lead_id`、`course_id`、`campus_id`、`teacher_id`（教师或 `null`）、`date`、`start_time`、`status`（`scheduled` 已安排 | `attended` 已到 | `absent` 未到 | `cancelled` 已取消）、`feedback`（0–500 个字符，默认 `""`）、`created_at`；列表与详情另带 `lead_name`、`course_name`、`teacher_name`。
- AC2 创建：线索必须没有结束（否则 409）；新建为 `scheduled`，线索改为 `trial_scheduled`；同一条线索同时只能有一个 `scheduled` 的试听 → 409。
- AC3 `POST /api/trials/:id/complete`，请求体 `{"attended", "feedback"}`（`attended` 是布尔）：`scheduled` → `attended` 或 `absent`；`attended` 时线索改为 `trialed`，`absent` 时线索改回 `contacted`。
- AC4 `POST /api/trials/:id/cancel`：`scheduled` → `cancelled`，线索改回 `contacted`。线索已经结束（转化或流失）时，完成或取消它的试听不改线索的状态。新建试听的日期不限。
- AC5 `scheduled` 的试听可以 PATCH `course_id`、`teacher_id`、`date`、`start_time`（日期不限）；不是 `scheduled` 的试听不能完成、取消或 PATCH → 409。`GET /api/trials` 可选查询参数：`lead_id`、`date`、`campus_id`、`status`；按 `date`、`start_time`、`id` 升序。`sales` 只看到自己负责的线索的试听。

## 线索转化 `POST /api/leads/:id/convert`  REQ-017

- AC1 请求体可选给出学员字段（`name`、`gender`、`birth_date`、`grade`、`school`、`phone`、`campus_id`，规则同 REQ-012），没给的取线索的 `name`、`grade`、`phone`、`campus_id`。
- AC2 新建学员，线索改为 `converted`，`student_id` 填新学员的编号；返回 201 与新学员。
- AC3 已结束的线索 → 409。

## 优惠 `/api/discounts`  REQ-018

- AC1 字段：`id`、`name`（1–30 个字符，不区分大小写唯一）、`type`（`amount` 立减 | `percent` 按比例减）、`value`（`amount` 型是减掉的金额，1–10000000；`percent` 型是减掉的百分比，1–90 的整数）、`min_amount`（订单原价达到多少才能用，默认 0）、`valid_from`、`valid_to`（日期或 `null`；都给时 `valid_from ≤ valid_to`，否则 400）、`active`（默认 `true`）。
- AC2 被订单用过（任何状态的订单，含待支付与已取消的）的优惠不能删除，也不能改 `type`、`value` → 409（可以停用）；列表与详情另带 `used`（布尔，是否被订单用过）。
- AC3 `GET /api/discounts` 可选查询参数 `active`、`usable`（`true` 时只返回今天可用的：启用，且今天在有效期内；`null` 的一端不限）。

## 订单与收据 `/api/orders`  REQ-019

- AC1 创建：请求体 `{"student_id", "items": [{"course_id", "lessons"}], "discount_id", "note"}`：`items` 1–10 行，同一课程只能出现一次，`lessons` 1–200，课程必须启用（否则 400）；学员必须是 `active`（否则 409）；`discount_id` 可以为 `null`；`note` 0–200 个字符。
- AC2 金额：每行的 `price_per_lesson` 取下单时课程的单价，`amount = lessons × price_per_lesson`；`original_amount` 是各行之和。优惠必须启用、今天在有效期内，且 `original_amount ≥ min_amount`，否则 400；优惠金额 `discount_amount`：`amount` 型是 `min(value, original_amount)`，`percent` 型是 `floor(original_amount × value / 100)`；`payable_amount = original_amount − discount_amount`。
- AC3 优惠分摊到各行：除最后一行外，每行 `discount_share = floor(discount_amount × 行 amount / original_amount)`（`original_amount` 为 0 时都是 0），最后一行是剩下的；每行 `paid_amount = amount − discount_share`。
- AC4 字段：`id`、`no`（`OD` 加 6 位序号）、`student_id`、`items`（按请求里的顺序；`[{"id", "course_id", "course_name", "lessons", "price_per_lesson", "amount", "discount_share", "paid_amount"}]`）、`original_amount`、`discount_id`、`discount_amount`、`payable_amount`、`status`（`pending` 待支付 | `paid` 已支付 | `cancelled` 已取消）、`payment_method`、`note`、`created_by`、`created_at`、`paid_at`；列表与详情另带 `student_name`、`student_no`。
- AC5 页面上的金额预览按 AC2、AC3 的公式计算，以接口返回的为准。`pending` 的订单可以 PATCH（`items`、`discount_id`、`note`；给了 `items` 就整体替换，金额按当时的课程单价与优惠重新计算；只改 `discount_id` 时各行沿用原来的单价，按新的优惠重新计算）和 DELETE；其他状态 → 409。
- AC6 `POST /api/orders/:id/pay`，请求体 `{"method", "amount"}`（`method` 是 `cash` 现金 | `card` 刷卡 | `wechat` 微信 | `alipay` 支付宝 | `transfer` 转账 | `balance` 学员余额）：`amount` 必须等于 `payable_amount`，否则 400；`balance` 要求学员余额（REQ-033）足够，否则 409，够时从余额扣减；其他方式记一条 `payment` 类型的收款流水（字段见 REQ-034）。成功后 `pending` → `paid`，填 `paid_at`、`payment_method`，每一行生成一个课时包（REQ-020）；不是 `pending` → 409。收款流水从第二期起就要记录（查看的接口与页面在第四期）；第四期之前没有任何增加余额的操作，学员余额总是 0，用 `balance` 支付 → 409。
- AC7 `POST /api/orders/:id/cancel`：`pending` → `cancelled`；已支付的订单不能取消（走退费）→ 409。
- AC8 `GET /api/orders` 可选查询参数：`status`、`student_id`、`from`、`to`（下单日期）、`q`（单号包含它）；按 `id` 降序。
- AC9 `GET /api/orders/:id/receipt`：只有 `paid` 的订单有收据（否则 409），返回 `{"receipt_no", "order_no", "student_name", "student_no", "items": [{"course_name", "lessons", "paid_amount"}], "original_amount", "discount_amount", "payable_amount", "payment_method", "paid_at"}`；`receipt_no` 是 `RC` 加 6 位序号，第一次查看时生成，之后不变。

## 课时包与课时账户  REQ-020

- AC1 订单支付后每一行生成一个课时包；转课转入时也生成（REQ-032）。课时包字段：`id`、`student_id`、`course_id`、`order_id`（转课生成的为 `null`）、`order_item_id`（同上）、`course_transfer_id`（订单生成的为 `null`）、`lessons`、`remaining`、`paid_amount`、`recognized_amount`（已确认收入）、`released_amount`（退费或转出的金额）、`created_at`。`remaining` 初始等于 `lessons`，`recognized_amount`、`released_amount` 初始为 0。包的**剩余价值**是 `paid_amount − recognized_amount − released_amount`。
- AC2 扣课时（消课）：从这个学员这门课程 `remaining > 0` 的课时包里，按生成先后（`created_at`，相同时按 `id`）取最早的一个扣 1 节；扣完后 `remaining` 为 0 时确认这个包的全部剩余价值，否则确认 `floor(paid_amount / lessons)`；确认的金额加到 `recognized_amount`。
- AC3 任何时候课时包的 `remaining` 都不能小于 0，剩余价值也不能小于 0。
- AC4 `GET /api/students/:id/packages` 返回这个学员的全部课时包，可选查询参数 `course_id`，按 `id` 升序。
- AC5 `GET /api/students/:id/accounts` 返回每门有课时包的课程一项 `{"course_id", "course_name", "purchased", "consumed", "refunded", "transferred_out", "transferred_in", "remaining", "remaining_value"}`：`purchased` 是订单生成的课时数之和，`transferred_in` 是转课转入的课时数之和，`consumed`、`refunded`、`transferred_out` 是消课（扣除更正退回的）、退费、转出的课时数，`remaining` 是各包 `remaining` 之和，`remaining_value` 是各包剩余价值之和；按 `course_id` 升序。
- AC6 `GET /api/students/:id/ledger` 返回课时流水 `[{"id", "course_id", "package_id", "delta", "reason", "ref_type", "ref_id", "created_at"}]`：`reason` 是 `purchase` 购买 | `consume` 消课 | `restore` 更正退回 | `refund` 退费 | `transfer_out` 转出 | `transfer_in` 转入，`delta` 是课时变化（消课、退费、转出为负）；`ref_type` 是 `order` | `attendance` | `refund` | `course_transfer`，`ref_id` 是对应对象的编号（`attendance` 是点名所在课次的编号）；可选查询参数 `course_id`；按 `id` 升序。

# 第三期：班级、排课与考勤

## 班级 `/api/classes`  REQ-021

- AC1 字段：`id`、`code`（`CL` 加 6 位序号，自动生成）、`name`（1–40 个字符）、`course_id`、`campus_id`、`room_id`（必须属于这个校区，否则 400）、`teacher_id`（必须能教这门课程的科目，否则 400）、`term_id`（学期或 `null`）、`capacity`（1 到课程的 `max_students`，且不超过教室的 `capacity`，否则 400）、`start_date`（可以是过去的日期）、`schedule`（每周的上课时间 `[{"weekday", "start_time"}]`，1–7 条，同一个 `weekday` 只能有一条，否则 400）、`lesson_count`（总课次，1–200）、`status`、`end_date`（最后一节课的日期，发布前为 `null`）、`cancel_reason`（取消班级的原因，默认 `""`）、`created_at`；列表与详情另带 `course_name`、`teacher_name`、`room_name`、`campus_name`、`student_count`（当前在班人数）。
- AC2 每节课从 `start_time` 开始，上 `lesson_minutes` 分钟（课程的），结束时间不能晚于 `24:00`，否则 400。
- AC3 `status`：`planning` 筹备 → `active` 开课（REQ-022）→ `finished` 结课（REQ-029）；`planning`、`active` 可以 → `cancelled`（REQ-029）。
- AC4 `planning` 的班级可以 PATCH 任何可写字段，也可以 DELETE；`active` 的班级只能改 `name`，改别的 → 409；`finished`、`cancelled` 的班级不能改、不能删 → 409。
- AC5 `GET /api/classes` 可选查询参数：`status`、`course_id`、`campus_id`、`teacher_id`、`term_id`、`q`（名称或编号包含它）；按 `id` 降序。

## 发布班级与生成课次 `POST /api/classes/:id/publish`  REQ-022

- AC1 只能发布 `planning` 的班级（否则 409）：→ `active`，同时生成 `lesson_count` 个课次：从 `start_date` 起逐日往后，遇到 `schedule` 里的星期就排一节，节假日（REQ-009）跳过；课次的 `seq` 从 1 开始按时间顺序编号，`teacher_id`、`room_id` 取班级的；填班级的 `end_date`；返回 200 与班级。
- AC2 冲突检查：任何一节与同一教师或同一教室的未取消课次时间重叠（同一天，`[开始, 结束)` 区间相交，首尾相接不算），或不在教师的可上课时间内（REQ-011 AC4）→ 409，整个发布失败、什么都不生成，`message` 里写明第一处冲突的日期（`YYYY-MM-DD`）与原因。
- AC3 发布时班级的课程、教师、教室、校区必须都是启用的，否则 409。

## 课次 `/api/lessons`  REQ-023

- AC1 字段：`id`、`class_id`、`seq`、`date`、`start_time`、`end_time`、`teacher_id`、`original_teacher_id`（代课前的教师，没有代课为 `null`）、`room_id`、`status`（`scheduled` 待上课 | `completed` 已完成 | `cancelled` 已取消）、`cancel_reason`（默认 `""`）、`content`（课堂内容，点名时填写，默认 `""`）。课次只由发布、调课、代课、停课、点名改变，没有直接创建、修改、删除课次的接口。
- AC2 `GET /api/lessons` 必须给 `from`、`to`（日期，含两端，`to` 不早于 `from` 且 `to` 减 `from` 不超过 31 天，否则 400），给了 `class_id` 时 `from`、`to` 可以不给、也不限制相差天数；可选查询参数：`campus_id`、`teacher_id`、`room_id`、`class_id`、`course_id`、`student_id`（这个学员要上的课，见 AC4）、`status`；不分页，返回数组，按 `date`、`start_time`、`id` 升序；每项另带 `class_name`、`course_id`、`course_name`、`teacher_name`、`original_teacher_name`、`room_name`、`campus_id`、`campus_name`。
- AC3 `GET /api/lessons/:id` 返回列表里的一项，另外返回 `roster`：应到学员 `[{"student_id", "name", "no", "source", "attendance", "leave_status", "remaining"}]`（`source` 是 `class` 本班 | `makeup` 补课；`attendance` 是点名状态，没点名为 `null`；`leave_status` 是这个学员这节课最近一条请假的状态，没有为 `null`；`remaining` 是这个学员这门课程现在的课时余额），按 `student_id` 升序。
- AC4 应到学员：课次日期当天在这个班的学员（`join_date ≤ 课次日期`，且没有在课次日期或之前退班），加上补课到这节课的学员（REQ-028）。点名之后应到学员固定为点名时的名单；停课的课次照样有应到学员（按停课时的名单）。
- AC5 `teacher` 只能看到自己（`teacher_id` 是自己）的课次；代课的课次属于代课教师。

## 调课、代课与停课  REQ-024

- AC1 `POST /api/lessons/:id/reschedule`，请求体 `{"date", "start_time", "room_id"}`（`room_id` 可省略，表示不换教室；换的教室必须属于班级的校区，否则 400）：做和发布相同的冲突检查（REQ-022 AC2，排除这节课自己），另外这节课的应到学员在新时间有别的课（班级课次或补课）→ 409；成功后返回修改后的课次。
- AC2 `POST /api/lessons/:id/substitute`，请求体 `{"teacher_id"}`：新教师必须启用、能教这门课程的科目（否则 400），冲突检查同上（教师与可上课时间）；`original_teacher_id` 记最初的教师，多次代课不变，换回最初的教师时清空。
- AC3 `POST /api/lessons/:id/cancel`，请求体 `{"reason", "append"}`（`reason` 1–200 个字符；`append` 是布尔，默认 `false`）：→ `cancelled`，记 `cancel_reason`；`append` 为 `true` 时在停课前这个班最后一节未取消的课之后，按 `schedule` 往后顺延补一节（跳过节假日，`seq` 接着最大的编号，冲突检查同发布，冲突则整个停课失败 → 409），并更新班级的 `end_date`；班级的 `lesson_count` 不变。
- AC4 只能处理 `scheduled` 且还没开始（现在早于课次的日期加开始时间）的课次，否则 409。

## 分班 `/api/classes/:id/students`  REQ-025

- AC1 `POST`，请求体 `{"student_id", "join_date"}`（`join_date` 可省略，默认今天；可以是过去的日期，补录已经开始上课的学员）：班级必须是 `planning` 或 `active`（否则 409）；学员必须是 `active`（否则 409）；学员在这门课程的课时余额（REQ-020 的 `remaining` 之和）至少 1 节（否则 409）；已经在班里 → 409；当前在班人数已等于 `capacity` → 409。返回 201 与这一条。
- AC2 学员在这个班 `join_date` 当天及以后的课次，和他已在的其他班的课次、已安排的补课时间重叠 → 409。
- AC3 `GET` 返回当前在班的学员 `[{"student_id", "name", "no", "join_date", "remaining"}]`（`remaining` 是这门课程的课时余额），按 `join_date`、`student_id` 升序。
- AC4 `DELETE /api/classes/:id/students/:student_id`（退班）返回 204：退班日期是今天，学员不再是今天及以后还没点名的课次的应到学员；已点名的记录和课时不变。同一个学员退班后可以再加入。

## 点名与消课 `/api/lessons/:id/attendance`  REQ-026

- AC1 `POST`，请求体 `{"records": [{"student_id", "status"}], "content"}`（`status` 是 `present` 出勤 | `late` 迟到 | `absent` 缺勤 | `leave` 请假；`content` 是课堂内容，0–1000 个字符）：`records` 必须正好覆盖这节课的全部应到学员、每人一条，否则 400。
- AC2 只能给 `scheduled`、日期不晚于今天的课次点名，否则 409；成功后课次变为 `completed`，记 `content`，返回 200 与课次（含 `roster`）。
- AC3 `present`、`late`、`absent` 各扣这个学员这门课程 1 节课时（REQ-020 AC2，流水 `consume`）；`leave` 不扣。任何一个要扣课时的学员余额不足 → 409，整个点名不生效。
- AC4 这节课有已批准请假（REQ-027）的学员必须记 `leave`，否则 400。
- AC5 `GET` 返回 `[{"student_id", "name", "status", "package_id", "recognized_amount"}]`（`package_id`、`recognized_amount` 是这次扣课时用的课时包与确认的收入，没扣时为 `null` 与 0），按 `student_id` 升序。
- AC6 `PUT`（更正，请求体同 POST）：只能更正 `completed`、日期在 7 天内（今天减课次日期不超过 7 天）的课次，否则 409；第四期起，课次所在月份的工资单已确认或已发放（REQ-037）→ 409。先把原来每人扣的课时与确认的收入原样退回原来的课时包（流水 `restore`），再按新的状态重新扣；任何一步不满足条件则整个更正不生效。

## 请假 `/api/leaves`  REQ-027

- AC1 创建，请求体 `{"student_id", "lesson_id", "reason"}`（`reason` 1–200 个字符）：学员必须是这节课的应到学员（否则 400），必须是 `active`（否则 409）；课次必须是 `scheduled` 且还没开始（否则 409）；同一学员同一课次已有 `pending` 或 `approved` 的请假 → 409。
- AC2 字段：`id`、`student_id`、`lesson_id`、`reason`、`status`（`pending` 待审批 | `approved` 已批准 | `rejected` 已驳回 | `cancelled` 已取消）、`review_note`（默认 `""`）、`created_by`、`reviewed_by`、`reviewed_at`、`created_at`；列表与详情另带 `student_name`、`lesson_date`、`lesson_start_time`、`class_id`、`class_name`、`created_by_name`、`reviewed_by_name`。
- AC3 `POST /api/leaves/:id/approve`、`POST /api/leaves/:id/reject`，请求体 `{"note"}`（可省略，0–200 个字符，记到 `review_note`）：只能处理 `pending` 的，否则 409。批准时，这个学员在这个班已批准的请假（含这次）不能超过 `ceil(班级 lesson_count × 0.2)` 次，否则 409。
- AC4 `POST /api/leaves/:id/cancel`：创建人在课次开始前可以取消 `pending` 或 `approved` 的请假 → `cancelled`；别人 → 403；已开始或状态不对 → 409。
- AC5 `GET /api/leaves` 可选查询参数：`status`、`student_id`、`class_id`、`from`、`to`（课次日期）；按 `id` 降序。`parent` 只看到自己孩子的；`teacher` 只看到自己课次的（只读）。

## 补课 `/api/makeups`  REQ-028

- AC1 创建，请求体 `{"student_id", "from_lesson_id", "to_lesson_id"}`：学员在 `from_lesson` 的点名状态必须是 `leave`（否则 409）；`to_lesson` 必须是同一门课程、不同班级的课次（否则 400），且是 `scheduled`、还没开始（否则 409）；`to_lesson` 的应到人数已达到它所在班级的 `capacity` → 409；学员在 `to_lesson` 的时间有别的课（不算 `to_lesson` 本身）→ 409；同一节请假的课只能补一次（已有 `scheduled` 或 `done` 的补课）→ 409。
- AC2 返回 201 `{"id", "student_id", "from_lesson_id", "to_lesson_id", "status", "created_at"}`，`status` 是 `scheduled` 已安排（点名后 `done` 已完成）；学员成为 `to_lesson` 的应到学员（`source` 为 `makeup`），点名时照常扣课时。`to_lesson` 点名后补课的 `status` 变为 `done`。
- AC3 `DELETE /api/makeups/:id`：`to_lesson` 还没点名、还没开始时可以删除（204），否则 409。
- AC4 `GET /api/makeups` 可选查询参数 `student_id`、`status`，按 `id` 降序；每项另带 `student_name`、`from_lesson_date`、`from_class_name`、`to_lesson_date`、`to_lesson_start_time`、`to_class_name`。

## 结课与取消班级  REQ-029

- AC1 `POST /api/classes/:id/finish`：`active` 且全部课次都是 `completed` 或 `cancelled` → `finished`，否则 409。
- AC2 `POST /api/classes/:id/cancel`，请求体 `{"reason"}`（1–200 个字符，记到班级的 `cancel_reason`）：`planning` 直接 → `cancelled`；`active` 且没有 `completed` 的课次 → `cancelled`，全部 `scheduled` 的课次一并取消（`cancel_reason` 同班级的取消原因）；已有点过名的课次 → 409。
- AC3 班级结课或取消后，在班学员全部退班（退班日期是今天），课时不变。

## 学员考勤  REQ-030

- AC1 `GET /api/students/:id/attendance`，可选查询参数 `from`、`to`（课次日期）、`course_id`：返回这个学员的点名记录 `[{"lesson_id", "date", "start_time", "class_name", "course_name", "status"}]`，按 `date`、`start_time` 升序。
- AC2 `GET /api/students/:id/attendance/summary`（筛选同 AC1）：返回 `{"present", "late", "absent", "leave", "rate"}`，`rate` 是 `(present + late) / (present + late + absent)` 的百分数，四舍五入取整数；分母为 0 时 `rate` 是 `null`。
- AC3 `teacher` 只能看到这个学员在自己班级（课次）里的记录；`parent` 只能看自己的孩子（家长端用这两个接口）。

# 第四期：退费、转课、余额与课酬

## 退费 `/api/refunds`  REQ-031

- AC1 创建，请求体 `{"student_id", "course_id", "lessons", "to", "reason"}`：`lessons` 是要退的课时数，至少 1，超过这门课程的课时余额 → 409；`to` 是 `original` 原路退回 | `balance` 退到学员余额（页面可以用 REQ-020 的课时包按 AC3 预估金额，以接口返回的为准）；`reason` 1–200 个字符。新建为 `pending`，`amount` 是按当前课时包估算的金额（AC3）；返回 201。
- AC2 同一学员同一课程只能有一张 `pending` 的退费单 → 409。
- AC3 金额：从这门课程最晚生成的 `remaining > 0` 的课时包开始往前退（按 `created_at`、`id` 倒序）；从一个包里退 `k` 节时，`k` 等于这个包的 `remaining` 就退它的全部剩余价值，否则退 `floor(paid_amount × k / lessons)`；各包相加。
- AC4 `POST /api/refunds/:id/approve`，请求体 `{"method"}`（`to` 为 `original` 时必填，取值同订单支付方式但不能是 `balance`；`to` 为 `balance` 时忽略，批准后 `method` 仍是 `null`）：只能处理 `pending` 的（否则 409）；按批准时的课时包重新计算 `amount`，余额已不足 `lessons` → 409；扣减课时包（流水 `refund`），退的金额加到各包的 `released_amount`；`to` 为 `original` 时记一条 `refund` 类型的收款流水（金额为负），为 `balance` 时加到学员余额（REQ-033）。→ `approved`。
- AC5 `POST /api/refunds/:id/reject`，请求体 `{"reason"}`（1–200 个字符）→ `rejected`；`POST /api/refunds/:id/cancel`（创建人或 `admin`，别人 → 403）→ `cancelled`；只能处理 `pending` 的，否则 409。
- AC6 字段：`id`、`no`（`RF` 加 6 位序号）、`student_id`、`course_id`、`lessons`、`amount`、`to`、`method`（批准前为 `null`）、`reason`、`status`（`pending` 待审批 | `approved` 已批准 | `rejected` 已驳回 | `cancelled` 已取消）、`reject_reason`（默认 `""`）、`created_by`、`reviewed_by`、`created_at`、`reviewed_at`；列表与详情另带 `student_name`、`course_name`。`GET /api/refunds` 可选查询参数 `status`、`student_id`，按 `id` 降序。
- AC7 退费批准后，这门课程课时余额为 0 的学员从这门课程所有 `planning`、`active` 的班级退班（退班日期是今天）。

## 转课 `/api/course-transfers`  REQ-032

- AC1 `POST`，请求体 `{"student_id", "from_course_id", "to_course_id", "lessons"}`：两门课程不同、`to` 课程启用且单价大于 0（否则 400）；`lessons` 至少 1，超过 `from` 课程的课时余额 → 409；`from` 课程有 `pending` 的退费单 → 409。
- AC2 转出：按退费的算法（REQ-031 AC3）从 `from` 课程扣 `lessons` 节（流水 `transfer_out`），得到转出价值 `value`，加到各包的 `released_amount`。
- AC3 转入：`to_lessons = floor(value / to 课程的 price_per_lesson)`，为 0 → 409；生成一个 `to` 课程的课时包（`lessons = remaining = to_lessons`，`paid_amount = to_lessons × price_per_lesson`，流水 `transfer_in`）；`value − paid_amount` 加到学员余额（REQ-033；为 0 时不记余额条目）。
- AC4 返回 201 `{"id", "no"（"CT" 加 6 位序号）, "student_id", "from_course_id", "to_course_id", "lessons", "value", "to_lessons", "to_balance", "created_by", "created_at"}`；转出、转入、余额要么全部生效，要么全部不生效；另带 `student_name`、`from_course_name`、`to_course_name`、`created_by_name`。`GET /api/course-transfers` 可选查询参数 `student_id`，按 `id` 降序。
- AC5 转出后 `from` 课程余额为 0 的，同 REQ-031 AC7 退班。

## 学员余额 `/api/students/:id/wallet`  REQ-033

- AC1 `GET` 返回 `{"balance", "entries": [{"id", "delta", "reason", "ref_type", "ref_id", "created_at"}]}`：`reason` 是 `refund` 退费退到余额 | `transfer` 转课零头 | `payment` 用余额支付订单（负数）| `withdraw` 取现（负数）；`ref_type` 依次对应：`refund` 的是 `refund`（退费单），`transfer` 的是 `course_transfer`，`payment` 的是 `order`，`withdraw` 的是 `payment`（取现那条收款流水）；`entries` 按 `id` 升序。还没有任何记录时 `balance` 为 0、`entries` 为空。
- AC2 余额任何时候都不能小于 0。
- AC3 `POST /api/students/:id/wallet/withdraw`，请求体 `{"amount", "method"}`（`amount` 至少 1，超过余额 → 409；`method` 同退费批准）：余额减少，记一条 `withdraw` 类型的收款流水（金额为负），返回 200 与余额（同 AC1）。

## 收款流水 `/api/payments`  REQ-034

- AC1 订单支付（不含用余额支付）、原路退费、余额取现各记一条流水：`{"id", "no"（"PY" 加 6 位序号）, "type"（"payment" | "refund" | "withdraw"）, "student_id", "student_name", "order_id", "refund_id", "amount", "method", "created_by", "created_at"}`；`amount` 收款为正，退费与取现为负；`order_id`、`refund_id` 不相关的为 `null`；另带 `student_no`、`order_no`、`refund_no`（不相关的为 `null`）、`created_by_name`。`type` 的中文：`payment` 收款、`refund` 退费、`withdraw` 取现。流水不能修改或删除。
- AC2 `GET /api/payments` 可选查询参数：`from`、`to`（日期）、`type`、`method`、`student_id`；按 `id` 降序。
- AC3 `GET /api/payments/summary`，必须给 `from`、`to`：返回 `{"income", "outgo", "net", "by_method": [{"method", "income", "outgo", "net"}]}`，`income` 是正数金额之和，`outgo` 是负数金额之和的绝对值，`net = income − outgo`；`by_method` 只列有记录的方式，按 `method` 的字母顺序。汇总只按日期，给了列表的其他筛选参数也忽略。

## 收入确认 `GET /api/reports/revenue`  REQ-035

- AC1 必须给 `from`、`to`（课次日期，含两端）；可选 `campus_id`（按班级的校区）。
- AC2 确认的收入是这段时间内已点名课次里，`present`、`late`、`absent` 的点名记录确认的金额（REQ-026 AC5 的 `recognized_amount`，按更正后的当前结果）之和。
- AC3 返回 `{"total", "lessons", "by_course": [{"course_id", "course_name", "lessons", "amount"}], "by_campus": [{"campus_id", "campus_name", "lessons", "amount"}]}`：`lessons` 是扣课时的人次；没有数据的课程、校区不列；按编号升序。

## 课酬标准 `/api/pay-rates`  REQ-036

- AC1 字段：`id`、`teacher_id`、`course_id`、`amount`（每节课课酬，0–1000000）；同一教师同一课程只能有一条 → 409。有 `POST`、`PATCH`（只能改 `amount`）、`DELETE`；`GET /api/pay-rates` 返回数组（不分页），可选查询参数 `teacher_id`，每项另带 `teacher_name`、`course_name`。
- AC2 一节课的课酬：这位教师这门课程有课酬标准时用它，否则用教师的 `pay_per_lesson`；这节课实到（`present` + `late`）人数为 0 时按一半计，向下取整。
- AC3 课酬算给课次点名完成时的上课教师（`teacher_id`，代课时就是代课教师），取生成或重算工资单时的课酬标准。

## 工资单 `/api/payrolls`  REQ-037

- AC1 `POST`，请求体 `{"month"}`（`YYYY-MM`）：为这个月（按课次日期）有 `completed` 课次的每位教师生成一行（一个都没有时 `lines` 为空，照样生成）；同一个月只能有一张 → 409；返回 201。字段：`id`、`month`、`status`（`draft` 草稿 | `confirmed` 已确认 | `paid` 已发放）、`lines`（`[{"teacher_id", "teacher_name", "lessons", "lesson_pay", "adjustment", "adjustment_note", "total"}]`，按 `teacher_id` 升序）、`total`、`created_at`、`confirmed_at`、`paid_at`；`lessons` 是课次数，`lesson_pay` 是各节课酬之和，`adjustment` 初始为 0，`total = lesson_pay + adjustment`。
- AC2 `draft` 时：`POST /api/payrolls/:id/recalculate` 按当前数据重新生成各行（保留已有教师的调整额与调整说明，新出现的教师调整额为 0，不再有课次的教师去掉）；`POST /api/payrolls/:id/adjust`，请求体 `{"teacher_id", "amount", "note"}`（`amount` 是 −1000000 到 1000000 的整数，替换这位教师的调整额；`note` 0–100 个字符）：这位教师不在工资单里 → 400，调整后这一行的 `total` 小于 0 → 400。`draft` 的工资单可以 DELETE。
- AC3 `POST /api/payrolls/:id/confirm`：`draft` → `confirmed`；`POST /api/payrolls/:id/pay`：`confirmed` → `paid`；状态不对 → 409。`confirmed`、`paid` 的工资单不能重算、调整、删除 → 409。
- AC4 工资单确认后，这个月课次的点名更正 → 409（REQ-026 AC6）。
- AC5 `GET /api/payrolls` 按 `month` 降序；`GET /api/payrolls/mine?month=YYYY-MM`（`teacher`）：返回自己在这个月 `confirmed` 或 `paid` 的工资单里的那一行，另带 `status`；没有（包括没有绑定教师档案）→ 404。不给 `month` 时返回自己在全部 `confirmed`、`paid` 工资单里的行（每项另带 `month`、`status`），按 `month` 降序，没有时为空数组。

# 第五期：教学互动、家长端、通知与报表

## 作业 `/api/homeworks`  REQ-038

- AC1 字段：`id`、`class_id`、`lesson_id`（这个班的课次或 `null`；不是这个班的 → 400）、`title`（1–60 个字符）、`content`（1–2000 个字符）、`due_date`（创建时、以及修改时请求里给了 `due_date` 的，不能早于今天）、`created_by`、`created_at`；列表与详情另带 `class_name`、`lesson_seq`、`lesson_date`（没有关联课次时为 `null`）、`submitted_count`、`student_count`（当前在班人数）。
- AC2 只能给 `active` 的班级布置和修改作业 → 409（结课、取消后的班级的作业还能删除）；`teacher` 只能给自己的班级布置、修改、删除，否则 403。有 `POST`、`PATCH`（`class_id` 不能改，给了也忽略）、`DELETE`。
- AC3 `GET /api/homeworks` 可选查询参数 `class_id`；按 `due_date` 降序、再按 `id` 降序。
- AC4 有提交的作业不能删除 → 409。

## 作业提交与批改  REQ-039

- AC1 `POST /api/homeworks/:id/submissions`（只有 `parent`），请求体 `{"student_id", "content"}`（`content` 1–2000 个字符）：学员必须是自己的孩子（否则 403）、这个班的当前学员（否则 400）；每个学员只能提交一次 → 409；返回 201。`late` 是提交日期晚于 `due_date`。
- AC2 提交字段：`id`、`homework_id`、`student_id`、`content`、`late`、`score`、`comment`、`submitted_by`、`submitted_at`、`graded_by`、`graded_at`（没批改时后四项为 `null`）。`GET /api/submissions/:id`（能看这个作业的员工，以及这个学员的家长）；`PATCH /api/submissions/:id`（只有提交人）：没批改前可以改 `content`，批改后 → 409。
- AC3 `POST /api/submissions/:id/grade`（班级的教师、`academic`、`admin`），请求体 `{"score", "comment"}`（`score` 0–100 的整数；`comment` 0–500 个字符）：可以重复批改，以最后一次为准。
- AC4 `GET /api/homeworks/:id/status` 返回班里每个当前学员、以及已经提交过的学员（之后退了班的也算）各一项 `{"student_id", "name", "no", "submission_id", "submitted_at", "late", "score"}`（没提交时后四项为 `null`），按 `student_id` 升序；`parent` 只看到自己孩子的那些项。

## 考试与成绩 `/api/exams`  REQ-040

- AC1 字段：`id`、`class_id`、`name`（1–40 个字符）、`date`、`full_score`（1–1000 的整数）、`pass_score`（0 到 `full_score` 的整数，不给时是 `ceil(full_score × 0.6)`）、`created_at`；列表与详情另带 `class_name`。`GET /api/exams` 可选查询参数 `class_id`，按 `date` 降序。只能给 `active` 的班级新建和修改考试 → 409；`teacher` 只能管自己的班级的考试，否则 403。有 `POST`、`PATCH`（`class_id` 不能改；已录入成绩的考试不能改 `date`、`full_score` → 409）、`DELETE`（已录入成绩的 → 409）。
- AC2 `PUT /api/exams/:id/scores`，请求体 `{"scores": [{"student_id", "score"}]}`：`score` 是 0 到 `full_score` 的数，最多一位小数，或 `null`（缺考）；学员必须是考试日期当天在这个班的学员（否则 400），不能重复（否则 400）；整体替换这次考试的成绩，返回 200 与 AC4 的列表。
- AC3 `GET /api/exams/:id/roster` 返回考试日期当天在这个班的学员 `[{"student_id", "name", "no"}]`，按 `student_id` 升序（录入成绩用这份名单）。
- AC4 `GET /api/exams/:id/scores` 返回已录入的 `[{"student_id", "name", "score", "rank"}]`：`rank` 按分数从高到低排名，同分同名次（例如 1、2、2、4），缺考（`score` 为 `null`）的 `rank` 为 `null`；PUT 里没有的学员就是"没录入"，不出现在这里；按 `rank` 升序，缺考的排在最后，同名次按 `student_id` 升序。
- AC5 `GET /api/exams/:id/stats` 返回 `{"count", "absent", "avg", "max", "min", "pass_rate"}`：`count` 是有分数的人数，`absent` 是缺考人数，`avg` 是平均分四舍五入保留一位小数，`pass_rate` 是及格（`score ≥ pass_score`）人数占 `count` 的百分数、四舍五入取整数；`count` 为 0 时 `avg`、`max`、`min`、`pass_rate` 都是 `null`。

## 课堂反馈 `/api/lessons/:id/feedback`  REQ-041

- AC1 `PUT`（这节课的教师、`academic`、`admin`），请求体 `{"items": [{"student_id", "rating", "comment"}]}`（`rating` 1–5 的整数；`comment` 0–300 个字符）：只能给 `completed` 的课次写（否则 409，先于学员的校验）；学员必须是这节课点名为 `present` 或 `late` 的（否则 400，整个请求不生效）；`items` 可以为空；同一学员已有的反馈被替换，请求里没有的学员保持不变；返回 200 与 AC2 的列表。
- AC2 `GET` 返回 `[{"student_id", "name", "rating", "comment", "updated_at"}]`，按 `student_id` 升序。反馈不能删除。

## 家长端 `/api/parent/*`  REQ-042

- AC1 只有 `parent` 能用，其他角色 → 403。下面的 `:id` 不是自己的孩子 → 403。
- AC2 `GET /api/parent/children`：每个绑定的学员一项 `{"id", "no", "name", "grade", "campus_name", "accounts", "balance"}`（`accounts` 同 REQ-020 AC5，`balance` 同 REQ-033），按 `id` 升序。
- AC3 `GET /api/parent/schedule`，必须给 `from`、`to`（规则同 REQ-023 AC2），可选 `student_id`（只看这个孩子；不是自己的孩子 → 403）：所有孩子要上的课（同 REQ-023 的 `student_id` 筛选），每项是 REQ-023 AC2 的一项另带 `student_id`、`student_name`、`leave_id`、`leave_status`、`leave_review_note`（这个孩子这节课最近一条请假的编号、状态与审批意见，没有为 `null`）；同一节课两个孩子都上时出现两次；按 `date`、`start_time`、`student_id` 升序。
- AC4 `GET /api/parent/students/:id/attendance`（同 REQ-030 AC1）、`GET /api/parent/students/:id/scores`（每次考试一项 `{"exam_id", "exam_name", "class_name", "date", "full_score", "score", "rank"}`，按 `date` 降序）、`GET /api/parent/students/:id/feedback`（每条反馈 `{"lesson_id", "date", "class_name", "rating", "comment"}`，按 `date` 降序）、`GET /api/parent/students/:id/homeworks`（孩子当前所在班级的作业，每项是 REQ-038 的一项另带这个孩子的 `submission_id`、`submitted_at`、`late`、`score`，没提交时为 `null`）。scores 只列这个孩子有成绩记录（含缺考）的考试。
- AC5 家长通过 REQ-012 的 `GET /api/students/:id`、REQ-020 的三个接口、REQ-030 的两个接口、REQ-033 的 `GET` 也能看到自己孩子的数据（只读）。家长端不提供修改密码的页面。

## 站内通知 `/api/notifications`  REQ-043

- AC1 `GET /api/notifications`（只返回当前用户自己的，分页），可选查询参数 `unread`（`true` 只看未读）；按 `id` 降序；每项 `{"id", "type", "title", "body", "ref_type", "ref_id", "link", "read", "created_at"}`；`link` 是点这条通知要去的页面路径（见 AC4）。
- AC2 `GET /api/notifications/unread-count` 返回 `{"count"}`；`POST /api/notifications/:id/read` 返回 204（别人的通知 → 404）；`POST /api/notifications/read-all` 返回 204。
- AC3 下列操作成功时程序自动发通知（括号里是 `type`）：
  - 调课、代课、停课（`lesson_changed`；取消班级时一并取消的课次不发）→ 这节课应到学员的全部家长，以及涉及的教师（代课时新旧教师都发）的绑定用户；
  - 请假批准或驳回（`leave_reviewed`）→ 请假的创建人；
  - 作业批改（`homework_graded`）→ 这个学员的全部家长；
  - 订单支付（`order_paid`）→ 这个学员的全部家长；
  - 退费批准或驳回（`refund_reviewed`）→ 退费单的创建人；
  - 工资单确认（`payroll_confirmed`）→ 工资单里每位教师的绑定用户。
  每次操作给每个收件人发一条（一个家长的两个孩子都受影响时也只发一条；重复批改每次都发）；没有对应用户的不发，操作人自己不收。`ref_type`、`ref_id` 指向触发的对象（`lesson`、`leave`、`submission`、`order`、`refund`、`payroll`）。
- AC4 `title` 按类型固定：`lesson_changed` 课程变动、`leave_reviewed` 请假已审批、`homework_graded` 作业已批改、`order_paid` 订单已支付、`refund_reviewed` 退费已审批、`payroll_confirmed` 工资单已确认；`body` 是一句中文说明（写明课次日期、学员姓名、结果这类要点）。`link`：
  - `lesson_changed`：家长 `/parent/schedule?from=<课次所在周的周一>`（调课按调整后的日期），教师 `/lessons/<id>`；
  - `leave_reviewed`：家长 `/parent/schedule?from=<课次所在周的周一>`，员工 `/leaves`；
  - `homework_graded`：`/parent/homeworks`；`order_paid`：`/parent`；
  - `refund_reviewed`：`/refunds/<id>`；`payroll_confirmed`：`/my/pay?month=<月份>`。

## 公告 `/api/announcements`  REQ-044

- AC1 字段：`id`、`title`（1–60 个字符）、`content`（1–5000 个字符）、`audience`（`all` | `staff` | `parents`）、`campus_id`（`null` 表示全校）、`pinned`（默认 `false`）、`published_at`（发布前为 `null`）、`created_by`、`created_at`。
- AC2 有 `POST`、`PATCH`、`DELETE`。`POST /api/announcements/:id/publish`：填 `published_at`；已发布的 → 409。已发布的公告只能改 `pinned`，改别的 → 409；可以删除。`audience` 的中文：`all` 全部、`staff` 员工、`parents` 家长。`GET /api/announcements`（管理用）返回全部，含未发布的，按 `id` 降序。
- AC3 `GET /api/announcements/visible`（所有登录用户）：已发布、受众包含当前用户（`staff` 是除 `parent` 外的角色，`parents` 是 `parent`），且校区匹配（`campus_id` 为 `null`，或等于：家长任一孩子的所属校区、教师档案的所属校区；其他员工看全部校区的）的公告；`pinned` 的在前，再按 `published_at` 降序；每项另带 `campus_name`。员工在工作台、家长在家长端首页看到这些公告。

## 看板 `GET /api/reports/dashboard`  REQ-045

- AC1 可选查询参数 `campus_id`；给了时只统计这个校区（课次按班级的校区，学员与线索按所属校区，收款、请假、退费按学员的所属校区）。有权限的四个角色看到的数字相同（`follow_ups_due` 除外，见 AC2）。
- AC2 返回 `{"today_lessons", "today_completed", "today_attendance_rate", "active_students", "month_new_students", "month_income", "pending_leaves", "pending_refunds", "follow_ups_due"}`：
  - `today_lessons`、`today_completed`：今天未取消的课次数、其中已点名的；
  - `today_attendance_rate`：今天已点名课次的 `(present + late) / (present + late + absent)` 百分数，四舍五入取整数，没有时为 `null`；
  - `active_students`：当前在 `active` 班级里的学员数（去重）；`month_new_students`：本月新建的学员数；
  - `month_income`：本月收款流水的 `net`（REQ-034 AC3 的口径）；
  - `pending_leaves`、`pending_refunds`：`pending` 的请假、退费单数；
  - `follow_ups_due`：`next_follow_up` 不晚于今天、没有结束的线索数（`sales` 只算自己负责的，其他角色算全部）。

## 招生报表 `GET /api/reports/enrollment`  REQ-046

- AC1 必须给 `from`、`to`；可选 `campus_id`（线索按线索的校区，试听按试听的校区，订单按学员的所属校区）、`owner_id`（`sales` 用这个参数无效，总是只看自己的）。
- AC2 返回 `{"leads", "converted", "conversion_rate", "by_source": [{"source", "leads", "converted"}], "trials", "trials_attended", "orders", "order_amount"}`：`leads` 是这段时间（按 `created_at` 的北京日期）新建的线索数，`converted` 是其中现在已转化的，`conversion_rate` 是 `converted / leads` 的百分数、四舍五入取整数（`leads` 为 0 时为 `null`）；`by_source` 只列有线索的来源，按 `source` 字母顺序；`trials` 是试听日期在这段时间内、没有取消的试听数，`trials_attended` 是其中 `attended` 的；`orders`、`order_amount` 是这段时间（按 `paid_at` 的北京日期）支付的订单数与 `payable_amount` 之和。给了 `owner_id` 时线索与试听只算这个人负责的线索，订单只算这个人创建的；`sales` 总是按自己算。

## 消课、出勤与余额预警报表  REQ-047

- AC1 `GET /api/reports/consumption`（`admin`、`academic`、`finance`），必须给 `from`、`to`（课次日期），可选 `campus_id`（按班级的校区）、`teacher_id`（按课次的上课教师，代课的算代课教师）、`course_id`：返回 `{"lessons_completed", "lessons_cancelled", "attendance": {"present", "late", "absent", "leave"}, "consumed_lessons", "by_teacher": [{"teacher_id", "teacher_name", "lessons", "consumed_lessons"}]}`；`consumed_lessons` 是扣课时的人次；`by_teacher` 按已点名课次的上课教师统计（`lessons` 是他已点名的课次数），按 `teacher_id` 升序。
- AC2 `GET /api/reports/attendance`（`admin`、`academic`），必须给 `class_id`：这个班每个有点名记录的学员一项 `{"student_id", "name", "no", "present", "late", "absent", "leave", "rate"}`（`rate` 同 REQ-030 AC2），按 `student_id` 升序。
- AC3 `GET /api/reports/low-balance`（`admin`、`academic`、`sales`），可选 `threshold`（0–20 的整数，默认 3）、`campus_id`：当前在 `active` 班级里、这门课程的课时余额不超过 `threshold` 的学员与课程 `[{"student_id", "student_name", "course_id", "course_name", "remaining", "class_ids", "class_names"}]`（`class_ids` 是他在这门课程的 `active` 班级，升序，`class_names` 与它一一对应），按 `remaining`、`student_id`、`course_id` 升序。

## 导出 CSV  REQ-048

- AC1 `GET /api/exports/students.csv`（`admin`、`academic`、`sales`，筛选同 `GET /api/students`）、`GET /api/exports/orders.csv`（`admin`、`sales`、`finance`，筛选同 `GET /api/orders`）、`GET /api/exports/payments.csv`（`admin`、`finance`，筛选同 `GET /api/payments`）、`GET /api/exports/attendance.csv`（`admin`、`academic`，必须给 `class_id`，内容同 REQ-047 AC2）。不分页，导出全部符合条件的记录，顺序同对应的列表。
- AC2 响应头 `Content-Type: text/csv; charset=utf-8`、`Content-Disposition: attachment; filename="<名称>-<今天的 YYYYMMDD>.csv"`（名称是 `students`、`orders`、`payments`、`attendance`）；内容以 UTF-8 BOM 开头，第一行是表头，逗号分隔，每行（包括最后一行）以 `\r\n` 结尾；含逗号、双引号或换行的字段用双引号包起来，里面的双引号写两遍。
- AC3 列（表头照写）：
  - 学员：`学号,姓名,性别,年级,校区,手机,状态`；
  - 订单：`单号,学号,学员,原价,优惠,应付,状态,支付方式,下单时间,支付时间`；
  - 收款：`流水号,类型,学号,学员,金额,方式,时间`；
  - 考勤：`学号,姓名,出勤,迟到,缺勤,请假,出勤率`。
- AC4 取值写法：金额写成元、保留两位小数（例如 `1234.50`、`-80.00`）；时间写北京时间 `YYYY-MM-DD HH:MM`（秒舍去），没有时空着；年级写数字，没有时空着；性别 `男`、`女`、`未知`；学员状态 `在读`、`停读`；订单状态 `待支付`、`已支付`、`已取消`；流水类型 `收款`、`退费`、`取现`；方式 `现金`、`刷卡`、`微信`、`支付宝`、`转账`、`余额`（没有时空着）；出勤率写成 `85%`，没有时空着。

## 操作日志 `GET /api/audit-logs`  REQ-049

- AC1 下列操作成功时各记一条 `{"id", "user_id", "username", "user_name", "action", "target_type", "target_id", "detail", "created_at"}`（`user_name` 是操作人姓名，`detail` 是简短的中文说明；只要求记这些操作）：
  - 用户的创建、修改、删除：`user.create`、`user.update`、`user.delete`；
  - 订单支付、取消：`order.pay`、`order.cancel`；
  - 退费的创建、批准、驳回：`refund.create`、`refund.approve`、`refund.reject`；
  - 转课：`course_transfer.create`；余额取现：`wallet.withdraw`；
  - 点名、点名更正：`attendance.create`、`attendance.update`；
  - 调课、代课、停课：`lesson.reschedule`、`lesson.substitute`、`lesson.cancel`；
  - 班级的发布、结课、取消：`class.publish`、`class.finish`、`class.cancel`；
  - 工资单的确认、发放：`payroll.confirm`、`payroll.pay`。
- AC2 `target_type` 是被操作对象的类型（`user`、`order`、`refund`、`course_transfer`、`student`、`lesson`、`class`、`payroll`；取现是 `student`，点名与更正是 `lesson`），`target_id` 是它的编号。
- AC3 可选查询参数 `user_id`、`action`、`target_type`、`target_id`、`from`、`to`（`created_at` 的北京日期）；按 `id` 降序。操作日志不能修改或删除。
- AC4 页面上的中文名：`user.create` 新建用户、`user.update` 修改用户、`user.delete` 删除用户、`order.pay` 订单收款、`order.cancel` 取消订单、`refund.create` 发起退费、`refund.approve` 批准退费、`refund.reject` 驳回退费、`course_transfer.create` 转课、`wallet.withdraw` 余额取现、`attendance.create` 点名、`attendance.update` 更正点名、`lesson.reschedule` 调课、`lesson.substitute` 代课、`lesson.cancel` 停课、`class.publish` 发布班级、`class.finish` 结课、`class.cancel` 取消班级、`payroll.confirm` 确认工资单、`payroll.pay` 发放工资；对象类型 `user` 用户、`order` 订单、`refund` 退费单、`course_transfer` 转课、`student` 学员、`lesson` 课次、`class` 班级、`payroll` 工资单。

# 页面

原型在 `docs/prototype/`（从 `index.html` 进入），是低保真线框，**布局、字段、按钮和交互以原型为准**；颜色、字号、间距与组件写法以 `docs/prototype/DESIGN.md` 与 `theme.css` 为准。

| 页面 | 路径 | 原型文件 | 对应需求 | 期 |
|---|---|---|---|---|
| 登录 | `/login` | docs/prototype/login.html | REQ-002 | 一 |
| 工作台（第一期只有欢迎语与快捷入口，第五期补看板数字与公告） | `/` | docs/prototype/dashboard.html | REQ-045、REQ-044 | 一、五 |
| 修改密码 | `/account/password` | docs/prototype/password.html | REQ-002 | 一 |
| 用户管理 | `/users` | docs/prototype/users.html | REQ-003 | 一 |
| 校区 | `/campuses` | docs/prototype/campuses.html | REQ-005 | 一 |
| 教室 | `/rooms` | docs/prototype/rooms.html | REQ-006 | 一 |
| 科目 | `/subjects` | docs/prototype/subjects.html | REQ-007 | 一 |
| 课程 | `/courses` | docs/prototype/courses.html | REQ-008 | 一 |
| 学期与节假日 | `/calendar` | docs/prototype/calendar.html | REQ-009 | 一 |
| 教师列表 | `/teachers` | docs/prototype/teachers.html | REQ-010 | 一 |
| 教师详情与可上课时间 | `/teachers/:id` | docs/prototype/teacher-detail.html | REQ-010、REQ-011 | 一 |
| 线索列表 | `/leads` | docs/prototype/leads.html | REQ-014 | 二 |
| 线索详情（跟进、试听、转化、流失） | `/leads/:id` | docs/prototype/lead-detail.html | REQ-014、REQ-015、REQ-016、REQ-017 | 二 |
| 试听日程 | `/trials` | docs/prototype/trials.html | REQ-016 | 二 |
| 学员列表 | `/students` | docs/prototype/students.html | REQ-012 | 二 |
| 学员详情（资料、家长、课时账户与流水、订单；第三期起有考勤，第四期起有余额） | `/students/:id` | docs/prototype/student-detail.html | REQ-012、REQ-013、REQ-020、REQ-030、REQ-033 | 二、三、四 |
| 优惠 | `/discounts` | docs/prototype/discounts.html | REQ-018 | 二 |
| 报名下单 | `/orders/new` | docs/prototype/order-new.html | REQ-019 | 二 |
| 订单列表 | `/orders` | docs/prototype/orders.html | REQ-019 | 二 |
| 订单详情（支付、取消） | `/orders/:id` | docs/prototype/order-detail.html | REQ-019 | 二 |
| 收据 | `/orders/:id/receipt` | docs/prototype/receipt.html | REQ-019 | 二 |
| 班级列表 | `/classes` | docs/prototype/classes.html | REQ-021 | 三 |
| 新建与编辑班级 | `/classes/new`、`/classes/:id/edit` | docs/prototype/class-form.html | REQ-021 | 三 |
| 班级详情（课次、学员、发布、结课、取消） | `/classes/:id` | docs/prototype/class-detail.html | REQ-021、REQ-022、REQ-025、REQ-029 | 三 |
| 课表（周视图） | `/schedule` | docs/prototype/schedule.html | REQ-023 | 三 |
| 课次详情（名单、调课、代课、停课） | `/lessons/:id` | docs/prototype/lesson-detail.html | REQ-023、REQ-024 | 三 |
| 点名 | `/lessons/:id/attendance` | docs/prototype/attendance.html | REQ-026 | 三 |
| 请假 | `/leaves` | docs/prototype/leaves.html | REQ-027 | 三 |
| 补课 | `/makeups` | docs/prototype/makeups.html | REQ-028 | 三 |
| 我的课表（教师） | `/my/schedule` | docs/prototype/my-schedule.html | REQ-023、REQ-026 | 三 |
| 退费列表与发起退费 | `/refunds` | docs/prototype/refunds.html | REQ-031 | 四 |
| 退费详情与审批 | `/refunds/:id` | docs/prototype/refund-detail.html | REQ-031 | 四 |
| 转课 | `/course-transfers` | docs/prototype/course-transfers.html | REQ-032 | 四 |
| 收款流水与汇总 | `/payments` | docs/prototype/payments.html | REQ-034 | 四 |
| 收入确认 | `/reports/revenue` | docs/prototype/revenue.html | REQ-035 | 四 |
| 课酬标准 | `/pay-rates` | docs/prototype/pay-rates.html | REQ-036 | 四 |
| 工资单列表 | `/payrolls` | docs/prototype/payrolls.html | REQ-037 | 四 |
| 工资单详情（调整、确认、发放） | `/payrolls/:id` | docs/prototype/payroll-detail.html | REQ-037 | 四 |
| 我的课酬（教师） | `/my/pay` | docs/prototype/my-pay.html | REQ-037 | 四 |
| 作业列表 | `/homeworks` | docs/prototype/homeworks.html | REQ-038 | 五 |
| 作业详情（提交情况与批改） | `/homeworks/:id` | docs/prototype/homework-detail.html | REQ-038、REQ-039 | 五 |
| 考试列表 | `/exams` | docs/prototype/exams.html | REQ-040 | 五 |
| 考试详情（成绩录入、排名与统计） | `/exams/:id` | docs/prototype/exam-detail.html | REQ-040 | 五 |
| 课堂反馈 | `/lessons/:id/feedback` | docs/prototype/feedback.html | REQ-041 | 五 |
| 通知中心 | `/notifications` | docs/prototype/notifications.html | REQ-043 | 五 |
| 公告管理 | `/announcements` | docs/prototype/announcements.html | REQ-044 | 五 |
| 招生报表 | `/reports/enrollment` | docs/prototype/report-enrollment.html | REQ-046 | 五 |
| 消课与出勤报表 | `/reports/consumption` | docs/prototype/report-consumption.html | REQ-047 | 五 |
| 余额预警 | `/reports/low-balance` | docs/prototype/report-low-balance.html | REQ-047 | 五 |
| 操作日志 | `/audit-logs` | docs/prototype/audit-logs.html | REQ-049 | 五 |
| 家长端首页（孩子、课时、近期课程、公告） | `/parent` | docs/prototype/parent-home.html | REQ-042、REQ-044 | 五 |
| 家长端课表与请假 | `/parent/schedule` | docs/prototype/parent-schedule.html | REQ-042、REQ-027 | 五 |
| 家长端作业 | `/parent/homeworks` | docs/prototype/parent-homeworks.html | REQ-042、REQ-039 | 五 |
| 家长端成绩与反馈 | `/parent/reports` | docs/prototype/parent-reports.html | REQ-042 | 五 |
| 家长端通知 | `/parent/notifications` | docs/prototype/parent-notifications.html | REQ-043 | 五 |

## 页面通用要求  REQ-050

- AC1 每个页面一个路径（见上表），直接打开、刷新都能看到对应页面；没登录时打开任何页面都跳到 `/login`，登录后回到原来要去的页面。
- AC2 员工页面有统一的顶栏（系统名、当前用户与角色、未读通知数、退出；点用户姓名进修改密码页）和按角色显示的左侧导航，看不到没有权限的入口；家长登录后进入家长端（`/parent`），家长端用另一套更简单的布局（见 `docs/prototype/parent-home.html`），没有员工页面的入口；家长打开员工页面、员工打开家长端页面都显示无权限。
- AC3 列表页有加载中、空、出错、无权限四种状态（见 `docs/prototype/common-states.html`）；表单校验失败时在对应字段下显示 API 返回的 `message`；操作失败时显示 API 返回的 `message`。
- AC4 金额在页面上显示为元（两位小数），提交时换算成分；时间显示北京时间。
- AC5 分页的列表页有分页条，显示总数；页码与筛选条件写进网址参数，刷新后停留在同一页、同样的筛选。

# 不做的

在线支付对接、短信与微信推送、电子合同、积分与会员等级、手机 App、打印、找回密码、多语言、多币种、学员自己登录（只有家长端）。
