# stock rework-02 实验方案（10-18，开跑前写）

同 run-01 到 run-04、native-01、rework-01b 的项目（小仓库进销存，约 1 万行，三期）。用当前的流程跑完整一次：架构 S0（审查通过后合入主分支、在主工作区装依赖，用户验收后批准）→ 按 plan.md 的批次开发（后端按 domain 并行、前端一个 agent）→ 每批浏览器验收后签收 → 交付。rework-01b 卡在 S0 门禁，没有跑完。

## 输入（相对 rework-01b 补全了，接口语义不变，hidden.mjs 不用改）

- `PRD.md`：内容与编号不变（16 条 REQ、63 条 AC、页面表 14 行，`prd.ts` 解析无警告）。新增「用户与角色」表（由 REQ-002 AC5 整理）；「页面」一节改成样式以原型的 DESIGN.md 与 theme.css 为准（原来写"样式可以自己定"，和流程的前端基础冲突）。
- `ARCHITECTURE.md`：原来多数写「由架构师定」，补成具体选择：`node:http` 不用框架、`node:sqlite` 存储并且单据一个事务、`node:test`、测试用临时数据目录和空闲端口（3 个后端并行跑测试）、令牌存库、scrypt、不用 Docker 与 lint。
- `prototype/`：`theme.css` 改成变量（颜色、字号、间距、尺寸），外观基本不变（截图对比过，顶栏高度差约 3px），并加了 `[hidden]` 覆盖规则（run-03：登录页的 `display:flex` 盖掉 `hidden`，顶栏是空的）、`.alert .close`、`.toasts`；`DESIGN.md` 按模板重写（定位、布局、排版、颜色、组件、状态、交互、Do/Don't、自查）。说明补了以前做错过的几处：采购单与销售单的往来单位筛选与下拉只列对应类型（run-04、native-01 都列错过）；库存流水「单据」列各种单据链到哪里（run-04 链到 `/transfers/<id>` 打不开）；导出文件名与带令牌下载（run-04 文件名恒为 export.csv）；库存页同一时间只显示一个页签。
- `hidden.mjs`：不变，52 条（一期 18、二期 15、三期 5、页面 13、持久化 1）。
- 代码版本：182cb77 加上本次套件的提交，工作区干净。

## 怎么跑

Claude Code 通过 herdr 在右侧窗口开一个交互式 Pi 主会话，扮演用户（同 run-01 到 run-04，不用 `real-build.ts` 的模拟用户）。准备工作照 `real-build.ts`：

1. `~/pi-forge-runs/stock/rework-02/project`：`git init -b main`、最小 package.json、提交「空项目」。
2. `pi -p --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e <pi-forge>/src/pi-adapter/extension.ts --model magpie/workbuddy/glm-5.3 /forge-init`。
3. workflow.yaml 用 `applyExperimentConfig` 写实验配置（同下表），放入 `docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/prototype/` 并提交。
4. 右侧窗口：`PI_SKIP_VERSION_CHECK=1 pi --session-dir <run>/main-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e <extension.ts> <主会话插件> --model magpie/workbuddy/glm-5.3 --thinking high`，发 `/forge-build "stock"`。

我做的事（全部记进运行目录的 `interventions.log`）：

- **S0 验收**：门禁合入主分支后，在主工作区跑 `npm test`，用临时 DATA_DIR 起服务，查 health、admin 登录、14 个页面路径返回 HTML、看批准页。都正常就 `/forge-approve`；有打不开、跑不起来的问题，或批准页的提醒指出计划漏了 PRD 的需求（程序按 plan.md 的 yaml 生成任务，漏了的需求没人做），就 `/forge-reject` 写明现象。
- **每批签收**：跑 hidden.mjs 记录分数（只记录，不据此打回，保证交付时的分数还是盲测）；用浏览器打开本批的页面（造数据、走页面登录），只在打不开、控制台报错、失败请求、常驻错误提示、一直加载中时打回，写明页面与现象；否则 `/forge-approve`。
- **转给用户的事**：同 `real-build/user.ts` 的规则表：agent 提问 → `/forge unblock "按你的推荐做，以 PRD 和契约为准"`；失败次数用尽 → `/forge unblock`；审查轮数用尽、主会话已转交 → `/forge accept`；主会话的选择框选推荐项。表外的情况先记下现象再判断。
- 上限 480 分钟；30 分钟没有任何活动算卡住；模型暂停超过 10 分钟算基础设施故障（时间照算）。跑的过程中不改代码，程序问题记在 `notes.md`，跑完再修。

## 配置（规划角色换了模型，其余同 rework-01b）

10-18 开跑时 magpie 的 codex 只剩 gpt-6-luna 可用（gpt-6.1-sol、gpt-6-sol、gpt-6-astra、gpt-5.6-sol、gpt-5.5 都报「ChatGPT 账号不支持」）。第一次开跑的 architect 连续两次 400 后换成兜底模型，20 秒内中止，留在 `rework-02-aborted-gpt/`。用户决定规划角色改用 workbuddy/glm-5.3。它没有 medium 档（只有 low、high、max），所以用 high。Pi 的 models.json 原来没有这个模型，按 glm-5.3-flash 的条目补上（输出上限 64k 取自 magpie）；**单价是假设的**（输入 1.0、输出 3.2、缓存读 0.2 美元/百万 token，参照 GLM-5 的公开价），费用只作参考。

| 角色 | 模型 | 思考 |
|---|---|---|
| orchestrator（主会话）、architect | magpie/workbuddy/glm-5.3 | high |
| backend、frontend | magpie/workbuddy/glm-5.3-flash | low |
| reviewer、stage-qa | magpie/workbuddy/glm-5.3-flash | high |

升级关闭；兜底模型 glm-5.3-flash；`limits.max_parallel_backend` 3（模板默认），前端 1 个；其余取模板默认值；项目有 /forge-init 建的 codegraph 索引（同 rework-01b）；pi-playwright 0.1.2；Pi 1.1.0。

## 假设（与 run-04、native-01 对比；结论只看跑完的数据）

- H1 跑完：三批（或 plan.md 定的批数）都签收并交付，S0 门禁不再卡住。
- H2 质量不降：隐藏测试 52/52；交付后 13 个页面没有打不开、控制台报错、失败请求、常驻错误提示；往来单位筛选不再列出另一类单位（输入里写明了）。
- H3 冲突与返工更少：合并 + 同步冲突 < 13，写代码角色的返工 run < 27（run-04）。
- H4 不更慢：/forge-build 到交付 ≤ 334 分钟（run-04）。费用因规划模型不同、单价是假设的，只列出来，不判定。
- 对照 native-01（84 分钟、$1.77、52/52）：预期仍然更慢更贵，看多花的换来了什么。

## 指标（口径同 rework-01 方案，跑完用 `scripts/real-build` 的统计函数读 `.forge` 算）

各阶段墙钟与等用户时间；各角色模型调用、命中率、费用、工具调用、浏览器命令（会话条目按 id 去重）；返工 run、修复 run、冲突（合并/同步）、审查轮数与按页审查次数；前端空等；backend_issues 条数；隐藏测试按组；项目自带测试；我的介入次数与内容；交付后代码行数（后端、前端、测试）；13 个页面的浏览器检查结果。

留档：`~/pi-forge-runs/stock/rework-02/` 下的 project/、main-session/、interventions.log、notes.md、hidden-*.json（每批签收时与交付后）、summary.json、metrics.txt。
