# P3-02：生产身份与容器运行合同

本轮在 `224eb14` 的 main 上独立实现，关联 Issue #49。P3-01 审查在 [PR #48](https://github.com/SynapseOperator/mq-story-blog/pull/48)，本分支没有合并该 PR。这里交付生产候选配置和隔离演练工具；没有购买 VPS、生成正式凭据或部署网站。

## 运行结构

浏览器 → Caddy 80/443 → 非 root Next.js 3000 → PostgreSQL 18。只有 Caddy 发布主机端口；应用与数据库分别处于 internal 网络，数据库没有端口映射。媒体卷不在 `public/`，所有图片仍经既有权限查询、完整性核验和 no-store 响应。

`Dockerfile` 固定 Node 24.19.0、Caddy 2.11.9 及基础镜像 digest，`package-lock.json` 固定依赖。`app` 为 standalone 产物，`tools` 为离线操作镜像，`proxy` 为 Caddy 镜像；均默认 UID/GID 10001。构建不接收运行秘密；`.dockerignore` 使用白名单，排除本地配置、Git、备份和宿主机生成的 Prisma Client。`tools` 含完整依赖，仅按需启动，不是常驻服务。

应用只读文件系统，临时目录与 Next 缓存使用限额 tmpfs。PG18 挂载 `/var/lib/postgresql`，保留其版本目录。Compose 的 `volumes-init` 是明确调用的一次性 root 步骤：无网络、无秘密，只处理三个已挂载卷的根目录，不递归修改文件。其他服务不依赖 root 应用进程。

资源预算：应用 1536 MiB / 2 CPU、数据库 768 MiB / 1 CPU、Caddy 128 MiB / 0.5 CPU；维护工具按需 512 MiB。每服务日志最多约 30 MiB。4GB VPS 不应同时常驻 staging 与 production，也不应在主机上构建镜像。此预算不是压力测试结论；上机后仍需验证峰值、OOM 和容量告警。

## 显式配置与秘密

外部只读 JSON manifest，路径由 `MQ_DEPLOYMENT_CONFIG` 指定。必须在 Git 和应用目录之外，Linux 上不可写（0444）；禁止符号链接。例子中的 ID、域名只是结构示意：

```json
{
  "version": 1,
  "environment": "production",
  "deploymentId": "00000000-0000-4000-8000-000000000000",
  "database": { "host": "postgres", "port": 5432, "name": "mq_production" },
  "origin": "https://approved-domain.example",
  "media": { "root": "/var/lib/mq/media", "minFreeBytes": 1073741824 }
}
```

staging 使用 `mq_staging` 或随机 `mq_staging_<32 hex>`。数据库角色名称由 environment 和 deploymentId 派生，不接受任意角色列表；连接 URL 必须精确匹配主机、端口、数据库和身份。`NODE_ENV` 始终是 `production`，不借用 development/test 绕过保护。

应用需要五个秘密文件：`database_url`、`auth_secret`、`auth_proxy_secret`、`publish_signing_key`、`comment_signing_key`。由对应 `*_FILE` 变量读取，原始秘密环境变量和 Better Auth 别名会被拒绝。四个密钥为相互独立的 32-byte 随机值，以 64 位小写十六进制保存。生产生成、分发与启用须另获授权。

秘密文件必须是单硬链接普通文件、0400/0600、属 root 或当前 UID；进程仍需实际读取权限。Linux Compose 的 file secrets 是 bind mount，`uid/mode` 声明不能修复宿主机权限：应在私有父目录中准备 UID10001 的 0400 文件。PG 引导密码供 postgres 用户读取，单独准备为该镜像的 postgres UID，不能与应用秘密共用目录权限。manifest 所在目录也须允许容器遍历。Windows 文件 mode 不证明 ACL；本地演练使用 Linux named volumes 严格验证，不放宽生产检查。

默认关闭 `MQ_AUTH_ENABLED`、`MQ_MEDIA_ENABLED`、`MQ_PUBLISH_ENABLED`、`MQ_COMMENTS_ENABLED`。即使默认关闭，启动仍要求完整秘密、媒体身份与数据库权限核验。开关不是整个站点的访问控制；受控 staging 还需要主机防火墙/VPN 或入口访问限制。

秘密只在进程运行时进入内存环境，不在镜像层、构建参数或 Docker Config.Env 中。拥有宿主机 root/Docker 权限者仍能读内存和文件，这不是针对主机失陷的防护。禁止 `set -x`、打印进程环境、提交秘密文件或上传实验临时目录。

## 数据库身份与 11 个函数 owner

生产数据库单独由引导身份创建。一次性 bootstrap 要求明确目标、PG18、同时为 SUPERUSER 与目标数据库所有者的离线身份，以及空库；拒绝接管现有同名角色或开发/测试库。迁移通过独立非 superuser 身份执行，历史 001–008 不变。授权配置与校验见 `scripts/production/database-policy.mjs` 和 `database.mjs`。

| 身份 | 必要权限 | 明确禁止 |
|---|---|---|
| runtime | 普通认证、草稿、媒体状态、点赞、待审留言所需列；6 个受控业务函数 | 管理员授权、公开状态/指针/星位直接写入、历史 Revision 修改、签名密钥读取、DDL |
| migration | 拥有迁移对象、schema 与安装受信扩展需要的数据库 CREATE | superuser、CREATEROLE、CREATEDB、成员身份；不得挂到应用 |
| maintenance | 专用管理员初始化/撤销/凭据维护 | 故事读取/发布、审计表修改、删除授权 |
| mediaMaintenance | 媒体恢复状态、引用只读 | 账号和管理员授权 |
| backup | 三个应用 schema 的完整表只读，包含认证和密钥 | 所有写入、维护函数执行；不得挂到应用 |
| 11 个函数 owner | 各自函数需要的精确列/函数权限，NOLOGIN，无角色成员 | schema CREATE、通用更新、其他函数所有权 |

11 个 owner 一一对应：`mq_admin_grant_audit`、`mq_admin_credential_lock`、`mq_admin_credential_audit`、`mq_lock_admin_access`、`mq_lock_admin_credentials`、`mq_project_revision_assets`、`mq_apply_story_publication`、`mq_lock_story_like_access`、`mq_lock_comment_context`、`mq_guard_story_comment`、`mq_apply_comment_moderation`。

全部 SECURITY DEFINER 保留 `search_path=pg_catalog`，撤销 PUBLIC EXECUTE。仅为鉴权/上下文取锁的 owner 获得相应 `UPDATE(id)`；发布与审核 owner 另持矩阵中的业务列 UPDATE，该权限不会给运行登录身份。发布与审核仍独立验证 HMAC、事务、会话、授权及 CAS。引导身份和迁移身份属于受信离线高权限运维，不声称数据库 owner 能被这些限制约束。

启动和健康检查使用 runtime 自身连接核对目标标记、日志策略、角色标志/成员、函数 owner/EXECUTE、schema/表/列/序列授权；发现漂移拒绝启动或变为 unhealthy，绝不自动修复。权限升级不能靠重新启动得到放行。迁移部署额外核对 8 份历史 SQL 的 checksum 与完成记录。

## 首次初始化顺序

以下步骤由 `tools` 镜像运行，Compose 不自动执行维护，也不默认挂载任何维护秘密。每次操作仅通过只读 mount 和 `*_FILE` 提供该操作所需身份。命令中只出现文件路径，不能放连接串或密码。

1. 审核 manifest、镜像 digest、外部秘密文件权限、磁盘和日志配置；启动单独的 postgres。
2. `node scripts/production/database-cli.mjs bootstrap`：`BOOTSTRAP_DATABASE_URL_FILE`、`MQ_ROLE_PASSWORDS_FILE`。后者为 migration/runtime/maintenance/mediaMaintenance/backup 的独立随机密码 JSON，每值满足 `[A-Za-z0-9_-]{32,128}` 且五项互异（推荐 64 位 hex）。只接受空库；bootstrap/provision/keys 均须离线 SUPERUSER 且为本库 owner。
3. `... database-cli.mjs migrate`：仅 `MIGRATION_DATABASE_URL_FILE`，执行正式 Prisma migrate deploy 001–008。
4. `... database-cli.mjs provision`：仅 `BOOTSTRAP_DATABASE_URL_FILE`，同一事务设置 11 owner 与完整权限矩阵；验证失败整体回滚。
5. `... database-cli.mjs keys`：引导连接及两个独立签名秘密文件；只允许首次插入，不覆盖旧密钥，不是轮换命令。
6. `... database-cli.mjs audit`：仅 `RUNTIME_DATABASE_URL_FILE`，只读核验。不得用引导身份代替 runtime 验收。
7. 显式执行 `docker compose ... run --rm volumes-init`，再运行 `node scripts/production/init-media.mjs` 建立不可跨环境复用的 `.mq-deployment.json`；只接受空卷或完全匹配的现有身份。实际调用入口见隔离演练，不调用实验管理员初始化去创建正式账号。
8. 最后才启动 app/proxy。应用在监听 3000 前完成全部校验。审核通过的生产管理员初始化、备份封装和密钥轮换另行授权，不使用实验 CLI 创建真实账号。

上述 database-cli 的四个 production 写操作必须追加 `--confirm-production=<deploymentId>`；staging 不接受这个参数。该确认防误操作，不代替操作系统权限或负责人授权。错误目标、过高身份、不完整配置会返回非零，诊断不输出 SQL 或秘密。

升级时先停止业务写入、验证可恢复备份，再用迁移身份部署新增版本，重新 provision/audit 后切换已审核镜像。当前只允许已核实的 8 份迁移；未来新增迁移必须同时审查权限矩阵和迁移清单。应用镜像可回退不意味着数据库可以降级；不可逆迁移必须恢复成套数据库与媒体快照，不运行 reset 或修改历史 SQL。

## 代理、存储与失败路径

Caddy 先删除客户端所有 `X-Mq-*` 和 `Forwarded`，再设置私有代理密钥和直接 TCP 对端 IP；不信任客户端 XFF。首版 Caddy 是直接互联网入口，不支持未经审查叠加 CDN。保留真实 Host/Origin，应用继续验证 Origin/CSRF/Secure Cookie。认证体上限 4KiB、留言 8KiB、全局 3MiB，头部与读写有期限。现有数据库共享限流继续生效；上机后需补主机级连接/带宽与告警策略。

没有 Caddy 管理 API 或明文 access log。数据库错误为 terse、不记录语句/参数；应用只输出固定故障码。代理密钥仍存在 Caddy 内存，系统转储和运维诊断也必须受控。

媒体根 0700、文件 0600，UID10001；环境/部署 ID 标记阻止挂错卷，保留既有路径、符号链接、原子写入和不覆盖对象保护。真实 `statfs` 在写入前要求预留空间，空间不足拒写但不阻止已有文件读取与受控清理。这是写入余量保护，不是硬配额，不能保证并发写或其他进程不会占满磁盘。40GB SSD 建议先预留 OS/镜像 12GB、数据库 5GB、媒体 10GB、维护余量 8GB，其余日志；不要长期在本盘保存完整备份或构建缓存。正式容量限制和外部备份待上机确认。

## 验证入口与证据边界

```sh
npm run check
npm run test:production:db
docker build --target app -t mq-p302-app:local .
docker build --target tools -t mq-p302-tools:local .
docker build --target proxy -t mq-p302-proxy:local .
npm run test:production:container
```

数据库套件沿用原有 guarded test 实例，仅创建/清理自己的随机 staging 数据库和角色。容器演练另建随机 Compose project、数据库、媒体及秘密卷，Caddy 仅绑定 loopback 随机端口，使用内部临时 CA。Node HTTPS 客户端校验该 CA；Playwright 仅对这一临时 CA 使用 context 范围证书例外，不关闭应用 TLS/Origin/CSRF。演练生成合成账号与图文，走实际上传、草稿、签名发布、点赞、留言审核、撤权及浏览器；文件和数据库卷经过容器重建仍保留。另用真实 8MiB tmpfs 验证空间不足，不填满宿主机磁盘。

成功后仅删除本次随机项目的容器/卷；失败保留其卷供检查，日志只保留脱敏诊断。没有 global prune、down -v，也不碰开发库。临时秘密、数据库和备份不上传 CI Artifacts。截图仅含合成内容。Windows 宿主测试与 Linux 容器权限测试分别记录，不能把 Windows mode bits 当作 Linux 权限证据。

CI 保留原有 quality/database 全套检查，新增独立 container job。现有取消过时 PR 运行仍有效；构建重用同一个 runner 的 Docker 层，不上传带凭据的缓存。最终提交必须有真实成功 CI 与匹配的独立 Review；本轮不自动合并。

本轮 Windows 本机已执行以下命令，均退出 0；详细 CI 结果以此 PR 的最终提交检查为准，不把本地结果冒充远端结果：

| 检查 | 实际结果 |
|---|---|
| `npm run check` | lint、Schema、typecheck、218 单元测试（214 通过，4 个 Windows 平台跳过）、production build |
| `test:production:db` | 随机 PG18.6 库，8 组检查；受限迁移、11 owner、角色隔离与危险权限漂移拒绝 |
| Linux 新配置/媒体单测 | 18/18，通过实际 UID10001 容器运行，无跳过 |
| `test:db`、`test:auth:limiter`、`test:auth:transactions`、`test:auth:logs` | 原有迁移、限流、事务与数据库日志回归 |
| `test:auth`、`test:admin`、`test:admin-drafts` | 真实 PostgreSQL / HTTP / HTTPS，全部通过 |
| `test:admin-editor`、`test:admin-preview`、`test:public`、`test:likes`、`test:comments`、`test:publishing` | 原有浏览器、分享、权限与业务回归，全部通过 |
| `test:media`、`test:media:upload`、`test:media:stories`、`test:media:lifecycle` | 媒体、真实进程中断恢复、图文浏览器及隔离备份恢复通过 |
| `test:production:container` | 空库到低权限 HTTPS 全流程、桌面/手机、重建持久化、撤权、错误配置及真实低容量 tmpfs 均通过 |

构建环境为 Docker Engine 29.9.2 / Compose 5.6.1，应用 Node24.19.0 / Next16.4.2 / Prisma7.10.1，PG18.6 / Caddy2.11.9。首次本地演练暴露 tmpfs YAML 逗号解析错误，已改为完整引号字符串并添加 Docker 实际挂载回归；另修正 Caddy 可信头清理顺序。生产图片、账号和密钥未参与测试。

首轮 [CI #42188671327](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42188671327) 的 quality/container 成功，database 在 8 组新检查通过后的清理阶段失败。`Pool.end()` 返回时服务器可能还未处理连接关闭，强制删库触发未处理 idle error，并打印驱动 Client 信息。本次日志没有发现数据库口令，但包含后端取消密钥，不能视为安全诊断格式。修复改为等待本次目标库连接数归零再正常 DROP，不强杀连接；新增生产脚本也监听 idle error，仅记录失败标志并固定码拒绝。保留真实延迟关闭/终止连接回归与入口故障测试；依据 [pg.Pool error 接口](https://node-postgres.com/apis/pool#error)。原失败记录保留，不作为通过证据。

依赖扫描：`npm audit --omit=dev` 退出 0，运行依赖无已报告项；全量扫描报告 10 个 moderate，均在 ESLint/TypeScript ESLint/minimatch 开发工具链。未执行自动升级或修改锁文件。维护镜像含开发依赖，正式使用前仍需单独评估及更新验证。

## 尚未开放的门槛

- Better Auth 1.7.12 默认 Session Token 仍原值存库。数据库/备份读取者能获取 token；Cookie 签名不等于 token 已哈希。兼容哈希方案需要独立 Spike，验证框架查询、注销、过期及管理员数据库函数，不能只改一列或声称本轮已修复。
- 正式域名、可信 HTTPS、主机防火墙/SSH、备份加密签名与异地恢复、磁盘硬配额/告警、容器更新、生产密钥生成/轮换和独立安全审查尚未验收。
- 新生产身份矩阵已在隔离库验证；现有备份/管理员维护工具的本地目标保护不被放宽。正式生产备份恢复与管理员运维入口须在下一轮受控 staging 演练，不把旧测试库恢复证据当作新生产身份的完整恢复证据。
- 本轮不实现 Session 哈希、生产密钥轮换、远端 CD、购买/部署；这些涉及独立安全决定或尚不存在的 VPS。仓库合并和测试成功均不授权公开注册、留言或正式发布。
