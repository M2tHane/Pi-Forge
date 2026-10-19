# 流程推演：大模型应用平台

用一个假想的项目，从头到尾走一遍 `/forge-build`：每一步开哪个分支、在哪个目录、谁读哪些文件、改哪些文件。
推演基于 10-18 的代码（S0 审查通过后合入主分支、在主工作区装依赖起服务）。没有真实运行：流程、任务、分支的编号按程序的规则推出；架构师和审查者的具体产出（domain 怎么分、文件名、计划分几批）是假设。

## 项目设定

- 项目目录 `~/code/llm-platform`，主分支 `main`。任务的工作目录放在同级的 `~/code/llm-platform.worktrees/`。
- 功能：模型接入（管理员配置模型地址与密钥）、应用（提示词与模型参数）、知识库（上传文档、检索）、对话（流式回复、历史）、用量统计、用户与团队。
- 技术栈：React、FastAPI、PostgreSQL（Docker）。

## 分支一览

| 分支 | 谁用 | 用途 |
|---|---|---|
| `main` | 用户 | 需求输入；S0 审查通过后的架构产出；交付时的全部代码 |
| `flow/B-001/integration` | 程序 | 本次流程的集成分支：所有任务合入这里 |
| `flow/B-001/T-xxx` | 各任务 | 从集成分支最新提交开出；工作目录 `llm-platform.worktrees/B-001-T-xxx/`；合入后分支与目录都删掉 |

main 与集成分支之间只在这几个时刻有来往：

| 时刻 | 方向 | 做什么 |
|---|---|---|
| `/forge-build` | main → 集成分支 | 从 main 开出集成分支 |
| S0 审查通过（每次返工后再一次） | 集成分支 → main | `--no-ff` 合入 main，集成分支移到合入的那个提交 |
| 每个阶段开始 | main → 集成分支 | main 上有新提交（手工提交、`/forge-fix`）才合进来，没有就不动 |
| 最后一批批准 | 集成分支 → main | 全部代码 `--no-ff` 合入 main，流程结束 |

```
main:         A ── M1（S0 合入）───────────────────────────── M3（交付合入）
                     │                                         ↑
integration:         M1 ── S1 各任务 ── T-016 ──┬── S2 各任务 ── … ── S3
                                               │
T-008、T-009…:                                  └─ 从这里开分支
```

## 第 0 步：准备（用户，流程外，main）

1. `/forge-init`：生成并在 main 上提交一次：`workflow.yaml`（流程配置，用户的，agent 只读）、`commands.yaml`（模板，全是注释）、`AGENTS.md`（模板）、`rules/global.md`、`docs/contracts/`、`docs/arch/`、`tests/acceptance/` 三个空目录、`.gitignore` 追加的几行。建 `.forge/`（流程状态，不进 git）。示例放 `docs/examples/`，不提交。
2. 用户写：`docs/PRD.md`（需求编号 REQ、验收标准 AC、页面表）、`docs/ARCHITECTURE.md`（技术栈）、`docs/prototype/`（每页一个 html，加 `DESIGN.md`、`theme.css`）。

## 第 1 步：`/forge-build`

- 检查：git 版本、`workflow.yaml` 格式；PRD 格式不对只提醒。
- PRD、技术栈、原型还没提交时，程序只把这几个路径提交到 main。
- 建流程 B-001（`.forge/flows/B-001/`），记下 main 当前提交；从它开出 `flow/B-001/integration`。
- 建任务 T-001「架构：骨架、契约与计划」，开分支 `flow/B-001/T-001`、目录 `llm-platform.worktrees/B-001-T-001/`，派架构师。

## 第 2 步：架构师提问，用户回答

架构师读 `docs/ARCHITECTURE.md`、`docs/PRD.md`、`docs/prototype/` 全部页面，核对技术栈。缺的一次问完（T-001 停在阻塞），这时不改任何文件。假设 ARCHITECTURE.md 只写了"React + FastAPI + PostgreSQL（Docker）"：

| # | 缺什么 | 建议的答案 |
|---|---|---|
| 1 | 向量检索 | PostgreSQL 的 pgvector 扩展，和业务数据同一个容器（`pgvector/pgvector:pg16`） |
| 2 | 调模型的方式 | 只接 OpenAI 兼容的 HTTP 接口，地址与密钥由管理员在后台配置 |
| 3 | 流式输出 | SSE |
| 4 | 测试时的模型 | 测试里起一个假的 OpenAI 兼容服务，返回固定内容 |
| 5 | 文档格式 | PDF、Word、Markdown，用 pypdf、python-docx 解析 |

用户：`/forge unblock T-001 "按你说的做"`。回答写进 T-001 的交接记录，任务回到进行中，架构师接着原来的对话做。

## 第 3 步：架构师写骨架、契约与计划（`flow/B-001/T-001`）

读 PRD、技术栈、原型和用户的回答；PRD、原型、`workflow.yaml` 只能读。写：

| 文件 | 内容 |
|---|---|
| `docs/arch/decisions.md` | 用户的 5 条回答 |
| `docs/arch/overview.md` | 目录结构、分层、依赖方向 |
| `docker-compose.yml` | 顶层 `name: llm-platform`；`db` 服务用 `pgvector/pgvector:pg16`，端口取 `${DB_PORT:-5432}` |
| `backend/pyproject.toml`、`uv.lock`、`backend/app/main.py`、配置 | 后端骨架与健康检查 |
| `frontend/package.json`、`package-lock.json`、Vite 配置、`src/main.tsx` | 前端骨架 |
| `docs/conventions.md`、`backend/app/common/` | 统一响应、错误码、分页 |
| `backend/app/auth/` | 鉴权接口、入口中间件、只供开发与测试的假实现（真实实现归 identity） |
| `docs/arch/domains.md` | identity、model、app、knowledge、chat、usage 六个 domain |
| `backend/app/domains/<domain>/` | 每个 domain 的接口与空实现、各自的迁移目录；Alembic 配置、建库删库脚本 |
| `docs/contracts/openapi.yaml` | 全部接口 |
| `docs/contracts/page-api.md` | 逐页核对原型：显示的数据、每个按钮对应的接口 |
| `frontend/src/` 路由外壳、API 客户端、mock | 由 openapi.yaml 生成 |
| import-linter、契约比对脚本、lint 配置 | 架构检查与契约检查 |
| `commands.yaml` | install、test、acceptance、serve、env_up（`docker compose up -d db`）、db_create、db_drop、arch_check、contract_check、lint |
| `rules/backend.md`、`rules/frontend.md` | 写代码的规则 |
| `tests/acceptance/_support/` | 按角色登录的助手、假的模型服务 |
| `tests/acceptance/T-001/` | 冒烟测试：前端 → 接口 → 数据库 |
| `AGENTS.md` | 约 100 行的目录 |
| `docs/plan.md` | 批次计划，末尾的 yaml 给程序读 |

在自己的目录里装依赖（`backend/.venv`、`frontend/node_modules`，不提交）、起容器 `llm-platform-db-1`、把每个命令跑一遍。计划假设为 4 批：B1 identity、model + 前端基础；B2 app、knowledge；B3 chat；B4 usage。

## 第 4 步：提交、审查、合入集成分支

- 提交：程序检查必需文件（AGENTS.md、overview、domains、openapi、page-api、带 `test` 的 commands.yaml、能解析的 plan.md），缺了退回；其余问题只提醒（例如某条需求没排进批次）。
- 审查 T-001.rv：审查者在同一个目录里只读；读改动、PRD 的验收标准、契约；跑架构师分支上 `commands.yaml` 的全量 `test` 与 `acceptance`（改的全是 `.md` 时不跑），跑之前程序在容器里给这次运行建一个库，跑完删掉。有必须改的退回架构师，最多 2 轮。
- 合入：T-001 的提交压成一个，进 `flow/B-001/integration`；T-001 的分支与目录删掉。

## 第 5 步：S0 门禁（主目录，main）

1. 集成分支 `--no-ff` 合入 main，集成分支移到合入的提交。主目录要干净，否则记事件、按 1、3、10 分钟自动重试。
2. 主目录执行 `install`（`backend/.venv`、`frontend/node_modules` 被 git 忽略）。
3. 主目录执行 `env_up`：compose 项目名写死，用的是架构师起的同一个容器。
4. 两条命令的输出存为门禁证据。

通知用户："架构产出已合入主分支，等你在主工作区验收后批准"。用户在主目录 `docker compose ps`、用 `serve` 启动看健康检查与前端外壳，读 plan、domains、openapi；`/forge report` 是批准页（批次、计划说明、风险与假设、提醒、项目命令）。

## 第 6 步：打回 S0

用户：`/forge-reject "knowledge 和 chat 放同一批"`。

- S0 回到进行中；新建 T-002「架构：骨架、契约与计划（返工）」，接着 T-001 的对话；任务说明里带历次打回的意见。
- `flow/B-001/T-002` 从集成分支（也就是 main 上的合入提交）开出；S0 期间没有共享依赖环境，程序先在新目录里 `install`。
- 架构师读意见、`docs/plan.md`、`domains.md`、PRD 的页面表；只改 `docs/plan.md`（chat 并进 B2，变成 3 批，对话页面跟着挪；chat 用 S0 定好的 knowledge 检索接口，不写 after，三个后端同时做）与 `decisions.md`（追加一条）。
- 提交 → 审查 T-002.rv（改的全是 `.md`，不跑测试）→ 合入集成分支 → 门禁再走一遍：第二个合入提交、install（依赖没变很快）、env_up（容器在跑，什么也不做）。

## 第 7 步：批准 S0

用户：`/forge-approve`。

- 再校验一次集成分支；集成分支已在 main 里，不再合并。
- 换成集成分支上的 `commands.yaml`；按 plan.md 生成 S1、S2、S3 与 13 个任务；记下此时契约所在的提交（只记录，不拦修改）。
- S0 完成，进入 S1。

| 阶段 | 后端（同时做） | 前端（按顺序） |
|---|---|---|
| S1 | T-003 identity、T-004 model | T-005 前端基础 → T-006 页面（B1）→ T-007 接入真实接口（B1） |
| S2 | T-008 app、T-009 knowledge、T-010 chat | T-011 页面（B2）→ T-012 接入真实接口（B2） |
| S3 | T-013 usage | T-014 页面（B3）→ T-015 接入真实接口（B3） |

## 第 8 步：S1 开发

- 开始前：把集成分支导出到 `llm-platform.worktrees/.env-shared/` 装一次前端依赖，各目录链接它；后端 `.venv` 不共享，各目录 `uv sync --frozen`。主目录 `env_up`（不起第二个容器）。
- T-003、T-004、T-005 同时派出，各自从集成分支开分支与目录；每次运行有自己的端口段，并在 `llm-platform-db-1` 里有自己的库。

| 任务 | 读 | 改 |
|---|---|---|
| T-003 identity | 它负责的需求与验收标准、openapi 里用户/团队/登录的接口、domains、conventions、`rules/backend.md`、AGENTS.md | `backend/app/domains/identity/**`（用户、团队、令牌、迁移，默认管理员也由迁移写）、鉴权的真实实现、单元测试、`tests/acceptance/T-003/` |
| T-004 model | model 的需求与验收标准、模型接入的接口 | `backend/app/domains/model/**`（模型配置、密钥加密、连通性测试）、测试、`tests/acceptance/T-004/` |
| T-005 前端基础 | 原型的 `DESIGN.md`、`theme.css`、各页面的公共部分 | `frontend/src/**`：复制 DESIGN.md 与 theme.css、公共组件、导航 |

- 开发任务不能改契约、架构文档、plan.md、AGENTS.md、PRD、原型、`workflow.yaml`。契约有问题时，后端问架构师；前端在提交时写明要后端补什么。
- 每个任务：提交 → 审查（只跑它改过的单元测试与 `tests/acceptance/T-00x/`）→ 压成一个提交合入集成分支 → 删分支与目录 → 后台对最新集成分支跑一遍全量回归，变红时找出是哪次合入，给那个任务建修复。
- T-005 合入后派 T-006：按页读原型 html 与 page-api.md 的对应部分，先接 mock 做，每页一个带 `[page:<页面id>]` 的提交，审查按页拆开同时看。
- T-003、T-004、T-006 都合入后派 T-007：前端从 mock 换到真实接口；不单独审查，由浏览器验收检查。

## 第 9 步：S1 门禁与浏览器验收

- 门禁：在临时目录对集成分支最新代码跑全量 test、acceptance、arch_check、contract_check（用自己的库），出需求覆盖报告并提交到集成分支的 `docs/qa/S1.md`；不通过自动建修复任务。
- stage-qa：在集成分支最新代码上启动服务（自己的端口与库），浏览器里逐页检查 B1 的页面；必须改的按归属交给对应任务。
- S1 期间 main 不动。通知用户："S1 阶段已通过检查，等你签收后进入下一阶段"；`/forge report` 给门禁结果、需求覆盖、stage-qa 结论、审查者的建议。

## 第 10 步：打回 S1

用户：`/forge-reject "模型列表页的密钥不该明文显示"`。

- S1 回到进行中，意见交给主会话；修改合入之前程序不重跑门禁。
- 主会话读集成分支上的 openapi（模型列表的返回）、model 的接口实现、前端模型列表页，判断归属：
  - 契约写的是打码、只是后端返回了原文：交给 T-004，程序建修复任务 T-004.fx-1，接着 T-004 的对话修。
  - 契约本身定了返回原文：涉及契约、后端、前端，交给架构师。
- 假设是后一种：新任务 T-016（咨询，阶段 S1），`flow/B-001/T-016` 从集成分支开出。架构师读意见、decisions.md、契约、model 的代码与模型列表页；改 openapi（列表与详情只返回 `api_key_masked`，`api_key` 只写不读）、`backend/app/domains/model/**` 与测试、`tests/acceptance/T-004/`（补一条：列表与详情里没有密钥原文）、前端模型列表页、decisions.md（追加一条）。一个人改完、跑相关测试后提交；咨询不单独审查，由门禁的 contract_check 与 stage-qa 把关。
- 合入集成分支 → 后台回归 → 门禁 → stage-qa 再验收 → 再次通知签收。

## 第 11 步：签收 S1，进入 S2

用户：`/forge-approve`。

- 同一次状态写入里 S1 完成、S2 进行中。
- S2 开始时：把 main 上的新提交合进集成分支（没有就不动）；S1 加了依赖时刷新共享依赖环境。
- S2 的任务从集成分支最新提交开出（带着 S0、S1 与 T-016 的修改）：T-008、T-009、T-010 同时做；T-011 接着 T-007 的对话做（前端任务跨批也接着上一个前端任务的对话），之后 T-012。后面同 S1。

## 第 12 步：最后一批签收，交付

用户在 S3 等签收时：`/forge-approve`。

1. 先确认："批准阶段 S3 将把 flow/B-001/integration 合入 main，流程随之结束。确认？"（没有界面时用 `/forge-approve --yes`）。
2. 检查：S3 没有没结束的任务；验收之后集成分支的代码没变过。
3. 交付汇报存为 `.forge/` 里的 `delivery.md`（各阶段完成、取消、修复的任务数，用时、费用、token，S3 的签收材料），之后用 `/forge report` 看。
4. 主目录要在 main 上且干净；集成分支 `--no-ff` 合入 main（"pi-forge: 合入 B-001 …"），主目录里的文件变成最终代码。
5. 流程结束："交付：已合入主分支"。

不会自动清理：`flow/B-001/integration` 分支、数据库容器（程序不会停它，要停就 `docker compose down`）、`.env-shared/`、`.forge/` 里的历史。

交付后：修缺陷用 `/forge-fix`，加小功能用 `/forge-change`（都直接合入 main，不分批、不批准架构）；改动更大时重新 `/forge-build`（B-002，从 S0 开始）。

## 附：`tests/acceptance/<任务>/`

每个任务自己的验收测试目录。按 PRD 的验收标准从外面测：测试自己启动服务、连真实数据库、调 HTTP 接口，一条验收标准对应一条测试，测试名里写编号（如 `REQ-012.AC3`）。程序扫这些编号算覆盖，缺的由审查者记成必须改的问题。审查者只跑本任务的目录（`acceptance -- T-004`），门禁跑全部。公共的 `_support/` 由 S0 写。前端任务的页面不在这里测，交给 stage-qa 在浏览器里查。单元测试在 `backend/tests/` 等目录，测函数与类。

## 推演中发现的问题

- S0 返工只改文档时，审查者照样跑全量 test 与 acceptance。已改：架构师的任务这一轮改的全是 `.md` 文件时不跑，文档引出的问题由第 1 批的回归与门禁兜底。
- `install`、`env_up` 在主目录改了受跟踪的文件（比如锁文件）或生成了新文件时，返工后再合入、交付合入会因主目录不干净出错。已改：改了的受跟踪文件还原成提交的版本，新生成的文件与目录（依赖、构建产物、容器的数据目录）写进本地忽略列表；执行前就有的改动不碰，各种语言一样处理。
- 没处理的风险：架构师没在 compose 里写死 `name:` 时，他起的容器和主目录起的会是两个，可能抢同一个端口。
