# 小组待办 技术栈

<!--
这是一份完整的示例，演示 docs/ARCHITECTURE.md 该怎么写，和 docs/examples/PRD.md 是同一个项目。示例只供参考，不会进 git，也不是本项目的技术栈。
技术栈由你定：架构师照这份文件搭骨架，不自己挑。写清用什么、什么版本；目录结构与分层由架构师写进 docs/arch/overview.md。
六节都要写：不需要的写「不用」，愿意交给架构师挑的写「由架构师定」。没写到的、或和 PRD 冲突的，架构师会先问你再动手。
程序只检查这份文件在不在，不解析内容。
整份照抄时：把本文件放到 docs/ARCHITECTURE.md。
-->

## 1. 后端

- Node.js 22 LTS，TypeScript 5，ES 模块。
- Web 框架：Fastify 5。
- 依赖管理：npm，提交 package-lock.json。

## 2. 数据库

- SQLite 3（单个文件；单个团队不超过 5000 条任务，单机够用），驱动 better-sqlite3。
- 访问方式：Drizzle ORM；迁移用 drizzle-kit，迁移文件提交进仓库。

## 3. 前端

- Vue 3 + Vite 6，TypeScript。
- 路由：Vue Router；不用状态管理库，页面数据各自从接口取。
- 不用 UI 组件库，照原型自己写样式。

## 4. 测试与检查

- 后端与前端的单元、接口测试：Vitest。
- 验收测试：Vitest 调接口（不开浏览器）；页面由批次验收在浏览器里检查。
- lint 与格式化：ESLint + Prettier。
- 架构检查：由架构师定。

## 5. 运行与部署

- 一台 Linux 服务器，一个 Node 进程同时提供接口和前端构建产物；不用 Docker。
- 不需要缓存、消息队列和对象存储。

## 6. 必须用与不能用的

- 密码哈希用 bcrypt。
- 不用需要付费或注册账号的云服务。
