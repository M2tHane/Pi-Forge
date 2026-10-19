# 小树培训学校教务系统 技术栈

<!-- 用户定的技术栈：架构师照这份文件搭骨架，不自己挑；写了「由架构师定」的项由架构师选。服务怎么启动、数据库容器怎么配，见 PRD 的 REQ-001。 -->

## 1. 后端

- Python 3.12 及以上，FastAPI，Pydantic v2，uvicorn。
- 依赖用 `uv` 管理：`pyproject.toml` 加 `uv.lock`，锁文件提交进仓库。
- 目录与分层由架构师定（写进 docs/arch/overview.md）。

## 2. 数据库

- PostgreSQL 16，跑在 Docker 容器里（`docker-compose.yml` 的 `db` 服务，见 PRD 的 REQ-001）。
- 访问方式：SQLAlchemy 2（同步或异步由架构师定），驱动 psycopg 3；表结构用 Alembic 迁移，服务启动时自动升级到最新版本，迁移文件提交进仓库。
- 金额、课时等需要精确计算的字段用整数存，不用浮点数。

## 3. 前端

- React 19 + TypeScript + Vite，路由用 React Router。
- 请求与状态管理由架构师定；不用 UI 组件库，照 `docs/prototype/` 的 `DESIGN.md` 与 `theme.css` 自己写公共组件。
- 构建产物由后端同一个进程托管（PRD 的 REQ-001 AC4）；开发时可以用 Vite 的开发服务器代理 `/api`。
- 依赖用 `npm` 管理，提交 `package-lock.json`。

## 4. 测试与检查

- 后端：pytest；接口测试用 FastAPI 的 TestClient 或 httpx，连真实的 PostgreSQL（同一个容器），**每次测试运行用自己的临时数据库**：几个任务在各自的工作区里同时跑测试，不能互相干扰。
- 前端：Vitest（组件与工具函数）；类型检查 `tsc --noEmit`。
- 验收测试：按需求逐条调用 HTTP 接口，不开浏览器；工具由架构师定。页面由每批的浏览器验收检查。
- lint：后端 ruff，前端 ESLint；架构检查（后端用 import-linter）、契约比对由架构师定。

## 5. 运行与部署

- 一个 uvicorn 进程同时提供接口和前端构建产物；只有数据库跑在容器里。
- `./setup.sh`、`./run.sh` 与 `docker-compose.yml` 的约定见 PRD 的 REQ-001。
- 不需要 Redis、消息队列和对象存储。

## 6. 必须用与不能用的

- 密码用 bcrypt 哈希。
- 登录令牌要能在退出、停用、改密码后立即失效（PRD 的 REQ-002、REQ-003），实现方式由架构师定。
- 时区：业务日期一律按北京时间（Asia/Shanghai）计算，不依赖服务器本机的时区设置。
- 不用需要付费或注册账号的云服务。
