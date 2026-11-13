# 本地开发与验证

本指南从一个新的 clone 开始，不需要作者电脑上的路径、Codex Skills、生产凭据或云服务账号。所有命令在仓库根目录执行；Windows PowerShell 如遇脚本执行策略问题，可将 `npm` 写为 `npm.cmd`。

## 选择运行范围

| 目的 | 入口 | 可以验证什么 |
|---|---|---|
| 浏览与修改前端场景 | `npm run dev` | 首页构图、动效、响应式布局；无数据库时不会填入演示故事 |
| 本地数据库与普通账号开发 | 下文数据库和认证步骤 | 001–010 迁移、注册、用户名登录、当前会话与退出 |
| 完整业务和部署边界验证 | `npm run test:production:container` | 随机隔离环境中的管理员、故事、图片、发布、点赞、留言与 HTTPS |
| 持续运行自己的完整实例 | [生产运行合同](engineering/PRODUCTION_FOUNDATION.md)与[发布流程](engineering/PRODUCTION_LAUNCH.md) | 独立运行身份、维护身份、私有媒体、签名密钥及受控部署 |

本地快速启动不会自动创建管理员、发布故事或初始化生产环境。完整容器测试使用合成数据，成功后清理自己的随机资源，不是一个长期保留的演示站点。

## 环境要求

- Node.js 24、npm 11。仓库构建基线为 Node **24.22.2**、npm **11.21.2**，依赖以 `package-lock.json` 为准。
- Git；数据库与容器测试另需 Docker Engine/Desktop 的 **Linux 容器**和 Docker Compose。不要在已有项目占用 55432/55433 时启动本地数据库。
- 完整容器测试会构建多个镜像并占用数 GiB 磁盘；先确认 Docker 有足够空间。运行时的资源预算见[生产合同](engineering/PRODUCTION_FOUNDATION.md)，它不等于构建内存预算。

```sh
git clone https://github.com/SynapseOperator/mq-story-blog.git
cd mq-story-blog
npm ci
```

仓库公开前，clone 需要仓库读取权限。`package.json` 的 `private: true` 仅防止误发 npm 包。

## 1. 只运行前端

```sh
npm run dev
```

访问终端显示的本地地址（通常是 `http://localhost:3000`）。没有数据库时，场景仍可显示，但公开故事接口不可用；不会回退到旧演示文章。没有已发布故事的星位不会变成可点击故事入口。M/Q 分区目前是建设中提示。

按 `Ctrl+C` 停止开发进程。要验证生产构建：

```sh
npm run build
npm start
```

## 2. 本地 PostgreSQL 与普通账号

首次执行：

```sh
npm run db:env
npm run db:up -- dev
npm run db:migrate
npm run db:status
npm run auth:env
npm run dev:auth
```

必须访问 **`http://127.0.0.1:3000`**。此入口固定回环地址并校验 Origin，不要混用 `localhost`。如果先前的开发服务仍占用 3000，请先停止它。

两份配置各自生成随机秘密，已有文件时会非零退出并保留原件：

| 被 Git 忽略的文件 | 内容与用途 |
|---|---|
| `.env.db.local` | 两个独立数据库密码和 `DEV_DATABASE_URL` / `TEST_DATABASE_URL`；只由本地数据库脚本读取 |
| `.env.auth.local` | 本地 HTTP Origin、认证开关、`AUTH_SECRET` 和独立 `SESSION_STORAGE_KEY`；由 `dev:auth` / `start:auth` 加载 |

不要把这些文件加入 Git、发送给他人或复制到部署环境。已有数据库卷保留原密码，不能删除环境文件再生成来完成轮换。Windows 下还应保护本地用户目录访问权限；POSIX mode 不代表 Windows ACL 已受限。

`db:migrate` 只应用仓库已有的增量迁移，不执行 reset 或 seed。当前迁移包括受保护 Session（009）与七星位（010）；既有数据和星位绑定由增量迁移保留。修改 Schema 应新增迁移，不改写已应用的 SQL。

页面账号入口可以创建普通用户并登录。普通注册不会成为管理员。停止并重新运行 `dev:auth` 会保留数据库；Session 读取依赖同一份认证及 Session Storage 密钥。

### 后台为什么不能直接使用这个数据库账号？

Compose 的 `mq_dev` 是本地数据库初始化/迁移身份，权限较高。管理入口的 `withAdmin` 会拒绝这种运行身份，即使账号登录成功也不能把它当作完整后台环境。不要为了本地运行移除权限检查。

后台需要独立的低权限 runtime 与 maintenance 身份、唯一管理员授权；发布、审核和媒体还需要各自配置。完整业务验证优先使用下一节的现成容器演练。需要持续运行的完整实例时，按[运行合同](engineering/PRODUCTION_FOUNDATION.md)配置全部五类身份和 11 个函数 owner，再使用[离线管理员工具](engineering/PRODUCTION_ADMIN.md)。

本地管理员维护入口 `npm run admin:maintain -- --database <库名> --operation init --username <新管理员名>` **不是 seed 命令**：它要求已配置的低权限维护身份 `MQ_ADMIN_MAINTENANCE_DATABASE_URL`、本地终端和准确确认短语，随后隐藏输入密码。不得使用 `mq_dev`、`mq_test` 或数据库 owner，不能把普通已注册账号提升为管理员。详细权限与本地调用示例见[管理员合同](engineering/ADMIN_AUTHORIZATION.md)。

## 3. 完整功能的自动化容器演练

以下命令使用现有 Dockerfile 和测试入口，所有账号、故事、图片与秘密均为新生成的合成数据，无需 OSS 或正式管理员：

```sh
npx playwright install chromium
docker build --target app -t mq-p302-app:local .
docker build --target tools -t mq-p302-tools:local .
docker build --target proxy -t mq-p302-proxy:local .
npm run test:production:container
```

脚本创建随机 `mq-p302-*` Compose 项目、staging 数据库、私有媒体卷与回环 HTTPS 入口，并验证真实 PostgreSQL 权限、认证、编辑与发布、图片、点赞、留言审核、容器重建和低磁盘拒写。它不会复用 `.env.db.local` 的开发库。

成功时只清理本轮随机资源；失败保留现场供检查。临时目录可能含合成秘密，不要整体提交或作为 CI Artifact 上传。不要用全局 `docker system prune`、`down -v` 或删除其他项目卷来处理失败。测试中的临时 CA、证书例外及合成账号不用于正式服务。

本套件不是“一键安装并保留后台”。希望手动使用一个长期实例，应遵循正式配置合同自行部署；现有在线站点也不是公共测试环境。

## 4. 按改动范围选择检查

```sh
npm run check
```

它依次执行 ESLint、Prisma Schema 校验、TypeScript、单元测试和生产构建；不等同于数据库或浏览器测试。修改文档通常只需链接、格式与命令合同核验。

需要真实数据库测试时，先启动专用测试实例：

```sh
npm run db:up -- test
npm run build
npm run test:db
npm run test:auth
npm run test:auth:session-storage
```

按业务范围另选 `test:admin`、`test:publishing`、`test:likes`、`test:comments`、`test:media:upload` 等，完整清单见 [package.json](../package.json)。涉及 Playwright 浏览器的套件需先运行 `npx playwright install chromium`；Linux 环境若缺系统依赖，应按 Playwright 的安装提示配置，不能用跳过浏览器断言替代。

数据库集成测试仅在 guarded test 实例中新建和清理自己的随机数据库/角色，不清空 `mq_test` 或开发库。`test:db:persistence` 会停止、启动和重建本项目两套本地数据库容器，运行前需结束依赖它们的开发会话；数据卷保留。

GitHub 工作流分为 Quality、Database、Container。维护者目前因 Actions 额度不足使用负责人明确批准的远端 CI 豁免；这不表示远端检查通过，也不替代本地验证、独立 Review 或 GitHub 实际保护规则。贡献者应在 PR 写清真实命令、退出码及未运行项。

## 5. 常见问题与边界

| 现象 | 处理 |
|---|---|
| `.env.*.local already exists` | 复用已有文件；确认它与现有卷对应，不覆盖或提交内容 |
| 数据库无法启动 | 检查 Docker Linux 引擎、磁盘、端口及项目服务状态，保留数据卷 |
| 页面没有可点击故事星 | 确认数据库可用且有已发布、绑定星位的故事；迁移不生成演示文章 |
| 登录返回 Origin 错误 | 使用 `http://127.0.0.1:3000`；不要关闭 CSRF/Origin 检查 |
| 已登录但后台被拒绝 | 普通用户无管理权限；默认本地数据库身份也不满足后台运行合同 |
| 集成测试找不到 `.next/BUILD_ID` | 先运行 `npm run build`；不要用过时构建验证新源码 |
| 修改环境变量后无效 | 确认使用对应启动入口，重启自己的开发进程；不要修改生产配置 |

生产和本地配置有不同合同。生产读取 Git 外秘密文件，不把本地 `.env`、开发数据库身份或测试 CA 带入生产。迁移、镜像更新、回滚和恢复参考[文档索引](README.md)；修改代码的授权不包含修改真实服务。
