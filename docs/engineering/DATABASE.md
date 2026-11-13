# PostgreSQL 开发与测试基础

本文件保留 [P2-02 / Issue #10](https://github.com/SynapseOperator/mq-story-blog/issues/10) 建立的开发/测试数据库合同及当时的验证记录。当前 Schema 已包含账号、故事、发布、媒体、点赞和留言，迁移为 001–010；页面读取真实已发布故事，不回退演示内容。首次运行见[本地指南](../DEVELOPMENT.md)，领域约束见 [STORY_LIFECYCLE.md](STORY_LIFECYCLE.md)。文内带日期或阶段编号的环境诊断、测试计数按原时点理解。

## 技术与隔离边界

- PostgreSQL 使用官方 `postgres:18.6-bookworm` 镜像；版本号固定，升级须通过迁移与集成测试。
- Prisma CLI、Client、PostgreSQL adapter 均锁定 `7.10.1`，`pg` 驱动锁定 `8.23.1`，由 `package-lock.json` 固定依赖树。
- `DatabaseProbe` 保留为独立基础设施探针；其后的业务 Schema 通过增量迁移建立，不能改写已经应用的历史 SQL。009 保护 Session 存储，010 将预设星位扩展为七个并保留原绑定。
- 首页场景可独立渲染，但真实故事与业务依赖数据库；数据库不可用时不返回旧演示文章。

| 环境 | Compose 服务 | 数据库 / 用户 | 本机入口 | 网络 / 命名卷 |
|---|---|---|---|---|
| 开发 | `postgres-dev` | `mq_development` / `mq_dev` | `127.0.0.1:55432` | `dev-network` / `dev-data` |
| 测试 | `postgres-test` | `mq_test` / `mq_test` | `127.0.0.1:55433` | `test-network` / `test-data` |

Compose 项目名为 `mq-story-blog`；实际 Docker 资源名带项目名前缀。两套 PostgreSQL 是独立实例、身份、网络与卷，端口只绑定本机回环地址。这两个身份是官方镜像在各自本地实例创建的数据库初始化角色，不是网站管理员，也不是未来部署的最小权限应用账号。每个服务限制为 1 CPU、512 MB 内存；这不包含 Docker Desktop / WSL 本身的开销。

PostgreSQL 18 卷挂载点是 `/var/lib/postgresql`，实际 `PGDATA` 为 `/var/lib/postgresql/18/docker`。不要套用旧版镜像常见的 `/var/lib/postgresql/data` 挂载方式。配置依据见 [PostgreSQL 官方镜像说明](https://hub.docker.com/_/postgres)。保留卷不是持久化验证：必须运行后文的停止、启动及容器重建测试。

## 凭据与本地启动

前提是 Docker Desktop 的 Linux 容器引擎与 Compose 已能正常运行。首次在仓库根执行：

```sh
npm ci
npm run db:env
npm run db:up
```

`db:env` 创建被 Git 忽略的 `.env.db.local`，生成两组独立随机密码；已有文件时拒绝覆盖。文件含 `MQ_DEV_PASSWORD`、`MQ_TEST_PASSWORD`、`DEV_DATABASE_URL` 和 `TEST_DATABASE_URL`，不提交或分享其内容，不打印连接串。其他开发者应各自生成自己的本地凭据。

命令默认操作本项目的两套容器，也支持只操作一个环境：

```sh
npm run db:up -- dev
npm run db:up -- test
npm run db:stop
npm run db:start
npm run db:recreate
npm run db:down
```

`db:down` 删除本项目全部数据库容器和网络，保留命名卷，不接受单环境参数；其他生命周期命令支持 `dev`、`test` 或默认 `all`。`db:recreate` 重建容器并重新挂载原卷。不要使用 `down -v`、全局 Docker prune 或删除其他项目资源来处理普通启动失败。已有卷里的 PostgreSQL 密码不会因为更改环境文件自动更新，不能通过重新生成 `.env.db.local` 假装完成凭据轮换。

## Schema、迁移与检查

为兼容 CI 中的 Compose 版本，`db:start` 使用 `up --no-recreate --wait` 恢复已有容器并等待健康，不依赖较新版本的 `start --wait`；没有容器时也可创建本项目容器。行为依据见 [Docker Compose up 官方说明](https://docs.docker.com/reference/cli/docker/compose/up/)。

`prisma/schema.prisma` 是 Schema 入口；首条迁移位于 `prisma/migrations/202610230001_database_foundation/migration.sql`，创建 `database_probe` 表：UUID 主键 `id`、最多 100 字符的合成值 `value`、带时区创建时间 `created_at`。迁移锁声明 PostgreSQL。迁移进入 PR 审查；不要把 `db push` 当作正式迁移历史，也不要为通过检查擅自重置数据库。

```sh
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run test:db
npm run test:db:persistence
npm run check
```

`db:generate` 与 `db:validate` 用于客户端生成和 Schema 检查；它们不证明数据库已连接或迁移成功。`db:migrate` 固定向开发库执行 `prisma migrate deploy`，`db:status` 固定检查开发库迁移状态；它们只应用或检查已有迁移，不生成迁移、不重置数据库，也不接受 `--name` 参数。后续 Schema 变更应新增迁移，经过 SQL 审查和从空库验证后提交，不改写已经应用的迁移。本轮 CI 还检查迁移结果与 Schema 的差异。

`test:db` 优先读取显式 `TEST_DATABASE_URL`，未设置时读取 `.env.db.local`。入口仅允许回环主机、明确端口、`mq_test` 用户与 `mq_test` 数据库；测试在该专用实例中新建随机命名的 `mq_test_it_<uuid>` 与 `mq_test_isolated_<uuid>` 两个空数据库。验证迁移 deploy、status、重复 deploy、Schema 差异、Prisma CRUD、主键唯一性、事务回滚和跨库隔离，最后只删除本轮创建的临时库，不清空 `mq_test`、开发库或其他运行的数据。该测试角色需要在自己的临时测试实例上创建和删除数据库的权限，不能把这一权限要求照搬到未来网站应用角色。

`test:db:persistence` 只读取 `.env.db.local` 的两套 Compose 连接配置，不跟随 CI 临时服务或外部 shell 的数据库变量。检查以同一个随机 UUID 在开发/测试库分别写入不同的合成值，验证身份与数据隔离，再验证本项目两套容器停止/启动和重建后仍能读回各自的值；不能用进程内缓存或连接未断开的读取代替。测试只清理其自身合成探针，不删除数据库卷。该检查会短暂停止本项目两套数据库，运行前应避开其他开发者正在使用的本机数据库操作。

`npm run check` 包含 Prisma Schema 校验和客户端生成，但不连接数据库，与真实数据库集成检查分开报告。没有 Docker 时仍可运行这些检查；数据库连接、空库迁移与持久化必须明确标记为未运行或失败，不能用 SQLite、Mock、lint 或构建结果替代。

Prisma 7 的配置与 adapter 选择参考 [官方升级说明](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)。客户端生成产物不作为手写源码维护；只在服务端和测试代码中使用数据库驱动，不向客户端传递连接串或数据库对象。

## GitHub Actions

CI 沿用现有 Quality 工作流，并增加独立数据库检查。临时 PostgreSQL 服务使用同一 PostgreSQL 18 镜像，从隔离空库执行正式迁移和集成测试；另使用本仓库 Compose 配置验证双实例隔离与持久化。服务仅存在于该次临时 runner 中，不连接本地、共享或生产数据库。

CI 临时服务只在一次性 runner 的回环端口使用 `trust`，不设置或展示共享密码；本地 Compose 与 CI 中的 Compose 验证均使用独立随机密码和 SCRAM。不能将临时服务的信任配置复制到本地 Compose 或部署环境。CI 不需要正式数据库密钥；本地随机密码不提交，CI 的临时随机值也不能写入可下载的日志、产物或缓存。工作流文件存在并不代表执行成功，结果须附具体 run 链接和被验证的提交 SHA。

## Windows 本机验收（2026-10-23）

最初没有 Docker 时，`db:env` 已创建本地凭据（退出 0），`db:up` 退出 1，`test:db` 因 `ECONNREFUSED` 退出 1；这些历史结果不代表数据库验证通过。之后负责人明确批准官方 Docker Desktop 安装，本次保留原有 `.env.db.local`，未重新生成或输出密码，补齐下列真实验证。

### 安装与环境

安装前确认 Windows 11 Home `10.0.26200`、WSL `2.6.3` 与现有虚拟化可用；约 31.7 GB 总内存、5.5 GB 可用，C / D 盘分别约 115.9 / 461.2 GB 空闲。55432 / 55433 未占用；保留现有 6 个 VirtualBox 虚拟机进程和停止状态的 Ubuntu。

安装程序来自 [Docker 官方 Windows 安装入口](https://docs.docker.com/desktop/setup/install/windows-install/)，实际下载域名为 `desktop.docker.com`，签名为有效的 Docker Inc.。安装器版本 `4.96.3.244472`，SHA-256 为 `3D8ADAD4F6C86583E0B00EA19A76197C51CCF5C83437C9ED775B739756452507`。执行 `install --user --backend=wsl-2 --quiet`，退出 0；未传入自动接受许可参数，许可及登录由使用者处理。安装位置为 `%LOCALAPPDATA%\Programs\DockerDesktop`。

| 项目 | Windows 本机实际结果 | 已通过的 Linux CI 实际结果 |
|---|---|---|
| Docker Desktop | 4.96.3，per-user | 不使用 Desktop |
| Docker Client / Engine | 29.9.2 / 29.9.2 | 28.0.4 / 28.0.4 |
| Compose | 5.6.1 | 2.38.2 |
| 容器后端 | Linux，WSL kernel `6.6.87.2-microsoft-standard-WSL2` | Linux runner |
| PostgreSQL | 18.6，`server_version_num=180006` | 18.6 |
| Prisma CLI / Client / adapter | 7.10.1 | 7.10.1 |
| pg / Node / npm | 8.23.1 / 24.19.0 / 11.17.0 | 8.23.1 / 24.19.0 / 11.17.0 |

Linux 证据：[当前代码提交 `5cdd02a` 的 Quality #16](https://github.com/SynapseOperator/mq-story-blog/actions/runs/39936781894)，quality / database 两个 job 成功。后续文档提交的最新 CI 在 PR #11 单独核对，不把旧 run 当作新提交证据。

本机 context 为 `desktop-linux`，连接本机 named pipe；未执行 `docker context use` 或手工改写全局 Docker 配置，未改动 `.wslconfig`。旧 Codex 进程未继承安装后的 PATH，因此本轮只给执行命令的进程补充 `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`，并设置进程内 `DOCKER_CONTEXT=desktop-linux`。新终端可直接检查 `docker version` / `docker compose version`；不要因此修改系统安全策略。

### 本机命令与证据

验证的代码提交为 `5cdd02ab13aac660aebbfb35f5d00e2411a91775`；后续收尾仅更新 README 和本说明。

| 实际命令 | 退出码 | 结果 |
|---|---|---|
| `npm.cmd run db:up` | 0 | 官方 PG18.6 镜像，开发/测试两个容器健康，端口仅绑定回环 |
| `npm.cmd run db:generate` / `db:validate` | 各 0 | Prisma Client 生成及 Schema 校验成功 |
| `npm.cmd run db:migrate` / `db:status` | 各 0 | 开发库正式迁移 deploy 及状态成功 |
| `npm.cmd run test:db` | 0 | 11/11，真实 PG 连接、两个隔离空库迁移、重复迁移与差异检查、CRUD、约束、回滚、隔离及清理 |
| `npm.cmd run test:db:persistence` | 0 | 5/5，双实例数据/身份隔离、停止启动、重建保留数据、重建后重复迁移 |
| `npm.cmd run check` | 0 | lint、Schema、typecheck、20/20 单元测试及生产构建 |
| 浏览器 `snapshot.mjs` / `regression.mjs` / `scene-regression.mjs` | 各 0 | 39 项阅读流程 + 19 项场景/入口检查通过 |

持久化测试前即时检查：两个实例的其他客户端会话均为 0、prepared transaction 均为 0；容器 label 均属于 `mq-story-blog`，没有停止其他本地任务。重建前后实际容器 ID 如下，命名卷保持不变：

| 实例 | 重建前 ID（前 12 位） | 重建后 ID（前 12 位） | 持续挂载的卷 |
|---|---|---|---|
| 开发 | `8906ecdf4758` | `0ceda98007cd` | `mq-story-blog_dev-data:/var/lib/postgresql` |
| 测试 | `895d96cc137d` | `a90d379ef60d` | `mq-story-blog_test-data:/var/lib/postgresql` |

两个实例均在停止/启动及重建后读回各自不同的合成标记；实际 PGDATA 为 `/var/lib/postgresql/18/docker`。验收后迁移 `202610230001_database_foundation` 均已完成，`database_probe` 均剩余 0 行，测试只清理自身探针。未执行 `down -v`、prune 或数据库 reset。两个容器最终保留为健康运行状态。

对比安装前快照确认 `.env.db.local` 内容未变且仍被 Git 忽略；全局 `.wslconfig` 未变，Ubuntu 仍停止，原有 6 个 VirtualBox 进程保留。未修改 BIOS、Hyper-V、Windows 安全策略或全局 WSL 配置，未采购服务。Docker 自有 WSL 发行版和镜像/卷占用属于已授权安装的新增资源。

浏览器复用现有 Playwright 1.64.1 / Chromium 156.0.8078.4，未新增依赖；生产构建 `ZtNkOwLT9BwmE_0B3kMzk`，视口 1536×1024、390×844、320×568、844×390。覆盖故事星/篝火对应文章、长文内部滚动、草稿保护、关闭、焦点、移动目录、reduced-motion、视差与固定 UI、M/Q 路由；意外 console/runtime/HTTP 错误为 0、写请求为 0，图片故障注入的 1 条预期 `ERR_FAILED` 单独记录。

本地截图与 JSON 位于当前 Codex 任务证据目录 `mq-p2-02-windows/`，不提交浏览器会话或大文件。手机是 Chromium 触屏模拟，未覆盖实体手机、Safari 或 Firefox。本轮未重复严格历史像素比较；此前桌面比较存在最大 2/255（首页）、6/255（阅读器）通道差的历史记录仍保留在 PR，不改写成像素零差。工程回归不等于新的产品视觉验收。

### Docker 启动问题的边界

用户登录后报告启动器找不到 `SOFTWARE\Docker Inc.\Docker Desktop` 注册表项。官方 `docker desktop start --timeout 45` 恢复成功（退出 0）；随后在没有容器时完成三次正常停止后的启动对照：根目录启动器使用安装目录、使用工程目录、直接打开原桌面快捷方式，均启动成功。没有手改注册表、快捷方式或重装。

普通快捷方式指向安装根目录启动器，浏览器 `docker-desktop` 协议登记指向 `resources` 下启动器；这是观察到的差异，不足以证明它导致报错。此前错误未复现，根因与浏览器登录回调触发条件仍未确认，不能声称已永久修复。若再现，先记录触发入口与错误，再用官方启动命令检查；不要凭猜测补注册表键或更改登录协议。

## 收尾边界

P2-02 已获负责人技术验收，PR #11 按其另行授权的一次性 Review Exception 合并，main CI 成功，Issue #10 completed 关闭。以上 Windows 验收记录是 P2-02 的历史证据，不冒充 P2-03 新增领域测试结果。P2-03 的唯一篝火、星位和版本归属约束及测试见领域说明；唯一管理员仍在后续用户/认证任务实现。P2-03 以新 Draft PR 提交，不自动合并或开始 P2-04。
