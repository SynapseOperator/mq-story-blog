# PostgreSQL 开发与测试基础

本文件对应 [P2-02 / Issue #10](https://github.com/SynapseOperator/mq-story-blog/issues/10)。这里只建设数据库运行、迁移与真实集成测试；页面仍使用四份合成演示故事，不创建用户、管理员、文章发布、点赞或留言服务。后续业务 Schema、服务端权限与发布版本约束在对应任务中实现。

## 技术与隔离边界

- PostgreSQL 使用官方 `postgres:18.6-bookworm` 镜像；版本号固定，升级须通过迁移与集成测试。
- Prisma CLI、Client、PostgreSQL adapter 均锁定 `7.10.1`，`pg` 驱动锁定 `8.23.1`，由 `package-lock.json` 固定依赖树。
- Prisma Schema 只包含合成 `DatabaseProbe`，用于验证写入、读取、迁移和持久化，不先定义或冻结未来业务实体。
- 当前 Next.js、TypeScript、npm 与前端测试流程继续保留；网站页面不依赖数据库才能展示现有原型。

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

## 当前本机状态与安装前置事项

2026-10-23 的实际检查结果：

| 检查 | 结果 |
|---|---|
| Windows | Windows 11 Home，版本 `10.0.26200` |
| WSL | `2.6.3`，Ubuntu 可启动，Linux kernel `6.6.87.2` |
| Hypervisor | `HypervisorPresent=true`；部分 CIM 虚拟化属性为 false，不能单凭这些属性判定 BIOS 虚拟化未启用 |
| Docker | PATH、常见系统/用户安装目录及 WSL 内未发现可用 Docker；没有安装或启动 Docker Desktop |
| 资源快照 | 约 31.7 GB 总内存、4.9 GB 可用；C 盘约 116.5 GB、D 盘约 461.6 GB 空闲 |
| 端口 | 检查时 `55432`、`55433` 未占用；实际启动前仍须重新检查 |

实际执行 `npm run db:env` 成功创建被忽略的本地凭据文件（退出 0）；`npm run db:up` 因没有 Docker 退出 1；`npm run test:db` 在连接阶段以 `ECONNREFUSED` 退出 1，未执行数据库迁移或读写。因此，本机的容器、迁移、停止/重启与重建持久化尚未通过验证。CI 上的真实验证即使成功，也不等于这台 Windows 工作站已完成本地验收。

建议批准后从 [Docker 官方 Windows 安装页](https://docs.docker.com/desktop/setup/install/windows-install/) 下载并验证 Docker Desktop，采用 per-user 安装与 WSL 2 Linux 容器后端。现有 WSL 先保留；首次启动由用户确认条款和需要的 WSL 集成，再验证 `docker version`、`docker compose version` 及引擎连通性，随后运行本文件中的数据库检查。

安装会增加 Docker 程序、容器镜像/数据占用及 WSL CPU/内存开销，可能要求重新登录或重启；本任务尚未执行这些系统操作。若安装器要求管理员权限、额外 Windows 功能或 BIOS 变更，先报告具体要求再确认。不自动修改 Hyper-V、BIOS、安全策略或全局 `.wslconfig`，不采购付费服务。官方条款需由使用者核对适用性。

## 收尾边界

P2-02 以 Draft PR 提交，独立记录本地与 CI 的命令、退出码和限制，等待项目负责人验收；不自动合并、不开始 P2-03。唯一管理员、唯一篝火、稳定星位、故事版本归属等数据库级业务约束仍属于后续任务，本轮探针迁移不能冒充这些功能已实现。
