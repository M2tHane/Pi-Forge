# edu run-01 实验方案（草稿，10-18：等 stock rework-01b 冒烟跑通后再开跑）

第一次用规模接近真实项目的输入跑改造后的流程：一家多校区课外培训学校的教务系统，PRD 50 条需求、5 期、55 个页面，技术栈 React + FastAPI + PostgreSQL（Docker）。目标是看流程在约 5 万行的项目上能不能从头跑到交付、质量如何、花多少时间与钱，以及哪里先撑不住。

## 输入

- `PRD.md`：50 条 REQ、209 条 AC、页面表 55 行对应 55 个原型文件；`src/core/spec/prd.ts` 解析无警告。分五期（基础资料 11 条、招生收费 9 条、排课考勤 10 条、财务课酬 7 条、教学互动与报表 13 条）。
- `ARCHITECTURE.md`：用户定的技术栈（Python 3.12 + FastAPI + SQLAlchemy 2 + Alembic、PostgreSQL 16 跑在 Docker、React 19 + TS + Vite、pytest / Vitest），目录与分层由架构师定。
- `prototype/`：55 个页面 + `index.html`（目录）+ `common-states.html`（四种状态、表单错误、确认框），`DESIGN.md` 与两层 token 的 `theme.css`；约 640 KB。页面由 6 个 subagent 按期写，写的过程中把发现的 PRD 遗漏（约 60 条：名称字段、中文名、缺的接口与参数）改进了 PRD，页面再按改后的 PRD 对齐过。
- `hidden.mjs` 与 `hidden/`：隐藏测试，见下。

## 隐藏测试

`node hidden.mjs <项目目录>`：用 `docker compose -p <随机名>` 加空闲 `DB_PORT` 起项目自己的 `db` 服务，两次 `./setup.sh`（可重复执行），`./run.sh` 带 `PORT` 与 `DATABASE_URL` 启动，按期跑 `hidden/p1.mjs … p5b.mjs`，最后检查 55 个页面路径返回 HTML、`/api/` 下不存在的路径返回 JSON 404、重启后数据与单号计数保留，结束时 `docker compose down -v`。

- 共 347 条：启动 5、一期 37、二期 69、三期 79、四期 52、五期 102（p5a 63、p5b 39）、页面与持久化 3。各期由一个 subagent 照 PRD 写，再由另一个 subagent 逐条对照 PRD 复核（改掉会冤枉正确实现的断言：同时违反两条规则的请求、字段集合全等比较、跳过分支在造数据失败时算通过等）。
- 对一个只实现了健康检查与登录的桩项目跑过一遍：只有启动、登录、页面路径、`/api` 404 这 10 条通过，其余全部失败、没有误判通过；某一期中途抛错时，没跑到的用例按失败计，总数不变。
- 各期造自己的数据（`fx.*`），需要精确统计的用例各建一个校区按 `campus_id` 筛选；时间按北京时间，要请假、调课的课次放在两天后，要点名的放在今天及以前。
- 写测试与复核时又发现约 40 处 PRD 含糊（校验先后、省略字段的默认值、退班当天的名单、停课顺延的位置、通知每人一条、CSV 最后一行的换行……），都已在 PRD 里写明。

驱动脚本的配套修改（10-18）：`runHidden` 默认超时 15 → 40 分钟（起容器、两次 setup）；项目自带测试改为执行交付项目 `commands.yaml` 的 `test`（不是 Node 项目时没有 `npm test`）。

## 怎么跑

```
node scripts/real-build.ts --suite scripts/real-build-suites/edu --max-parallel-backend 3 --max-min 2880 --out ~/pi-forge-runs/edu/run-01
```

- 脚本扮演用户，规则同 stock rework-01（`scripts/real-build/user.ts`）：批准、needs_human 时 accept、阻塞时 unblock、选推荐项，不打回。
- 上限 48 小时；30 分钟没有任何活动算卡住；模型暂停超过 10 分钟算基础设施故障。跑的过程中不改代码，问题记在运行目录的 notes.md。
- 交付后由我用浏览器抽查页面：每期挑 3 个（含家长端 2 个），做法同 stock。

## 配置

同 stock rework-01b：orchestrator 与 architect 是 gpt-6.1-sol medium，backend、frontend 是 glm-5.3-flash low，reviewer、stage-qa 是 glm-5.3-flash high；`max_parallel_backend` 3，前端 1 个；其余取模板默认值。

## 假设

- H1 能跑完：不需要规则表以外的介入就能交付（stock 规模上已经成立，这次看规模放大 5 倍后还成不成立）。
- H2 质量：隐藏测试 ≥ 90%；抽查的页面没有打不开、控制台报错、失败请求、常驻错误提示。
- H3 时间与费用大致线性：用时 ≤ stock rework-01b 的 6 倍，费用 ≤ 8 倍（文件多、契约大，架构与审查的上下文会更贵）。
- H4 S0 撑得住：架构师一次写出覆盖 50 条需求的契约与计划，后续批次里因为契约缺漏而发起的咨询与 backend_issues 合计 ≤ 20 条。

开跑前预计 20–40 小时、$30–80。

## 指标

同 stock rework-01 的 1–8 项；另外记录：每期（批次）的用时与费用、各角色单次调用的平均输入长度（看上下文是否膨胀）、交付后代码行数（后端、前端、测试分开，排除依赖目录）。

## 跑完怎么记结论

写进 NOTES.md 的"真实模型实验"，格式同 stock；没跑完的只写看到了什么。
