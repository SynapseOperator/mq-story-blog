# P2-10A：受控故事发布

对应 [Issue #37](https://github.com/SynapseOperator/mq-story-blog/issues/37)、PRD v1.1 §5.2、§5.4、§10.2 和 FN-08/09/10/14。本次从 main `1850610510928df9459420d4ffa1de671d2b4f9f` 独立开发，不依赖仍待独立评审的 [PR #36](https://github.com/SynapseOperator/mq-story-blog/pull/36)。素材删除和联合备份不能因此被视为本分支已有能力。

本阶段只有发布后端和隔离测试，没有发布管理 UI，也没有生产权限配置或真实内容发布。认证仍受原有开关控制；发布还要求显式设置 `MQ_PUBLISH_ENABLED=true` 和独立签名密钥，缺失时拒绝操作。

## HTTP 合同与生命周期

全部接口重新执行 `withAdmin`，要求有效的 Better Auth 数据库 Session、存在的用户与未撤销管理员授权。所有写入沿用 Origin、CSRF 来源检查和共享限流；响应为 `private, no-store`，无公开缓存。

| 接口 | 请求 | 结果 |
|---|---|---|
| `GET/HEAD /api/admin/star-slots` | 无查询参数 | 预设 `id`、`sceneKey` 与占用故事 `id/state`，包含草稿预留和下架保留 |
| `PUT /api/admin/stories/[id]/slot` | `{expectedVersion, slotId}`；slotId 可为 null | 仅未首次发布的 STAR 可选择、调整或释放星位 |
| `POST /api/admin/stories/[id]/publish` | `{expectedVersion}` | 首次发布当前草稿，或显式将已发布故事切换到新草稿 |
| `POST /api/admin/stories/[id]/withdraw` | `{expectedVersion}` | 下架已发布故事，保留星位和公开版本指针 |
| `POST /api/admin/stories/[id]/restore` | `{expectedVersion}` | 恢复下架前的公开版本，不发布之后保存的新草稿 |

客户端不能提交目标 Revision、发布状态、签名、Session ID、数据库角色或存储 Key。写操作返回 `{story:{id,version,state,slotId,hasUnpublishedChanges}}`，不返回正文或认证内部字段。输入错误为 400，不存在为 404，版本/星位竞争或不合法状态为 409，配置、数据库或素材完整性故障为脱敏 503；未登录、无管理员权限及限流沿用 401/403/429。过大或不合规 JSON 沿用已有请求读取器的 413/415 边界。

CAMPFIRE 仍不占普通星位，数据库继续保证全站至多一篇。首次发布后星位保持稳定；下架不释放星位。无空闲位置时拒绝选位，不能挤占他人位置。发布、下架或恢复均递增版本；失去 CAS 的请求回滚，不自动重试。

## 为什么需要数据库签名边界

现有运行时账号为了支持 Better Auth，具有 Session 的 SELECT/INSERT/DELETE。`mq_lock_admin_access(sessionId,userId)` 负责数据库授权核验和锁，不负责验证 HTTP Cookie 签名。若新增发布函数只接受这两个 ID，持运行时 SQL 权限的调用者可以伪造 Session 后冒用管理员。这是新增发布机制必须解决的边界，并不等于已经证明现有 HTTP 登录存在绕过。

006 新增 `mq_publish_private` 私有 Schema、空的 `signing_key` 单例表和 `mq_apply_story_publication(text,bytea)`。迁移不包含密钥、不创建全局数据库角色、不授予运行时发布权限。`pgcrypto` 安装于私有 Schema；若目标库已在其他 Schema 安装它，迁移拒绝，须另行审查，不能静默移动现有扩展。

服务器仅在已验证的最终 `withAdmin` 事务内签名。HMAC-SHA256 输入是固定顺序的字符串数组，直接对 UTF-8 原文签名：

1. 协议版本 `mq-publish-v1`。
2. 当前数据库名与连接登录身份 `session_user`。
3. `pg_current_xact_id()` 返回的当前事务 ID。
4. 服务端验证过的 Session ID 与 User ID。
5. `slot/publish/withdraw/restore` 动作、Story ID、expectedVersion。
6. 目标 Revision ID；选位操作为空。
7. 目标星位；非选位动作绑定现有星位，CAMPFIRE 为空。

签名和整个凭证只在服务器与数据库间传递，不进入浏览器响应、URL、应用日志或客户端存储。数据库参数日志仍须执行已有隐私配置，不能仅凭应用 console 脱敏宣称数据库诊断产物也安全。函数独立验证固定格式、HMAC、数据库/身份/事务绑定，再锁定管理员授权、用户及有效 Session，执行生命周期校验和 CAS。数据库的历史修订不可变、版本归属、稳定星位、唯一篝火与媒体引用约束仍保留。

同一凭证不能用于另一数据库身份、事务、故事、版本或动作。成功后版本递增，重复操作失去 CAS。权限撤销、退出或会话过期不能仅凭旧签名继续操作。应用复用 `createStoryOperations(tx)`，只替换发布操作的受控写入点；没有另起不受保护的写事务。

## 数据库权限矩阵

| 能力 | 应用 runtime | 发布函数 owner | 管理员维护身份 | 迁移/配置身份 |
|---|---|---|---|---|
| 原有认证、草稿、媒体权限 | 保留各自已有列级权限 | 无认证表直接读写；仅需故事/媒体读取 | 保留原有维护权限 | 受控配置 |
| 直接写发布状态、公开 Revision、星位 | **无** | 仅固定函数所需列 UPDATE，连同 version/updated_at | 无新增权限 | 受信任运维能力 |
| 执行发布函数 | 显式授予 EXECUTE，仍必须提供有效签名 | 函数所有者 | 不授予 | 初始化/所有权配置 |
| 发布密钥 | 无表/列权限，无私有 Schema 使用权 | 只读 | 无新增权限 | 受控一次性初始化 |
| Session/授权锁 | 原有窄锁函数 | 仅 EXECUTE 原有窄锁函数 | 原有撤销/重置流程 | 受控配置 |
| DDL、Schema CREATE、角色切换 | 无 | NOLOGIN；无 Schema/表所有权或角色成员资格 | 无新增权限 | 单独保管 |

发布函数固定 `search_path=pg_catalog`，所有业务对象使用限定名，撤销 PUBLIC EXECUTE。所有者是单独的 NOLOGIN 角色，不是应用、维护、数据库 owner 或超级用户。它不能创建/编辑 Revision、管理员授权或签名密钥。未完成最小权限 owner 配置时函数拒绝运行。

`scripts/publishing/privileges.mjs` 只允许明确命名的随机 `mq_test_admin_<32位hex>` 库，要求调用方先创建受限身份并完成原有管理员、草稿与媒体配置；验证实际有效权限，不只验证 GRANT 文本。应用启动和 HTTP 请求不会自动执行权限配置。

## 图片预检与最终事务

发布和恢复分为三步：

1. 短 `withAdmin` 事务确认版本，读取确切目标 Revision 和不可变素材清单。publish 取当前 draftRevision，restore 取原 publishedRevision。
2. 事务结束后逐一读取私有展示图和缩略图，核对真实字节数与 SHA-256。采用有界顺序 I/O，不持有管理员锁或长期数据库事务，也不上传或复制文件。
3. 新的 `withAdmin` 事务重新检查 Session/授权、Story 版本和状态、同一目标 Revision 及 READY 引用清单，然后签名。数据库函数再次校验归属、v2 内容与关联集合、READY 状态及 CAS，完成原子变更。

预检期间保存了新草稿或改变了状态，最终步骤返回冲突；不能自动改为发布后来出现的版本。下架不依赖文件可读，避免损坏文件阻止停止公开。v1 旧内容继续使用原公开读取合同；私有文件完整性预检针对 v2 的受管图片。

文件系统与 PostgreSQL 不构成分布式事务。005 的不可变元数据、历史引用与 READY 外键防止受控流程在预检后删除/替换被引用素材，但不能阻止有主机权限的外部进程篡改磁盘。存储目录权限、主机隔离及公开读取时的再次校验仍然必需。已发送给访客的字节也不能在下架后远程收回。

## 隔离密钥配置

`MQ_PUBLISH_SIGNING_KEY` 必须是独立随机 32 字节的 64 位小写 hex，不能复用 `AUTH_SECRET`。应用环境和数据库私有表需要匹配；不写入迁移、Git、命令参数、截图或 CI Artifacts。配置值仅由隔离测试在内存中生成，测试不能读取或修改现有认证密钥。

一次性初始化入口为：

```text
node scripts/publishing/initialize-key.mjs --database mq_test_admin_<本次随机ID>
```

它通过环境读取 `MQ_PUBLISH_PROVISION_DATABASE_URL` 和 `MQ_PUBLISH_SIGNING_KEY`，要求本机随机隔离库、TTY 精确确认和独立配置权限，并在写入前检查已审查的数据库日志策略。重复初始化拒绝，不覆盖已有密钥。当前没有生产初始化、自动轮换或密钥恢复命令；不要把测试专用入口放宽为生产工具。

## 威胁模型与开放门槛

本机制防止游客/普通用户调用、客户端角色或参数注入、运行时 SQL 身份直接修改发布字段、伪造或替换签名参数、跨事务重放、过期/撤销会话、并发发布覆盖和素材未校验即发布。

它不声称防御应用进程被控制、服务器签名密钥泄露、数据库 owner/超级用户失陷、恶意主机文件操作或备份凭据泄露。生产启用前仍须独立安全 Review、真实运行身份与文件 ACL、HTTPS/可信代理、数据库日志及备份访问控制、密钥保管/轮换/恢复方案。Better Auth Session Token 仍原值存库，不能称为已经哈希保护。共享管理员账号只能归因到账号，不能识别实际使用者。

## 验证记录

计划检查伪造/替换签名、跨事务/身份重放、过期与撤销 Session、密钥缺失、最小 owner 权限、发布与选位竞争、事务回滚、图片完整性，以及公开 API/HTML/RSC/metadata/图片 GET/HEAD 随生命周期同步。迁移回归保留 004→005，并增加真实 005→006、历史 checksum、v1/v2 内容和引用快照、空库部署及 Prisma drift。

Windows 隔离验收：`npm run check` 退出 0，135 项单测中 133 通过、2 项为已有平台文件系统限制；新增 `test:publishing` 退出 0，PostgreSQL 13/13、HTTP 15/15、HTTPS 15/15。测试进程用独立 preload 暂停真实文件读取，在暂停期间完成草稿保存与撤权，再验证发布拒绝；生产代码没有测试接口。桌面 1536×1024、触屏 390×844、320×568 reduced-motion 的真实生产构建浏览器回归通过，未捕获运行错误。

首轮发布 HTTP 测试的退出请求漏传 JSON `{}`，被已有认证入口拒绝。修正测试合同后完整重跑通过，没有放宽 Origin、内容类型或认证检查；初次失败日志与后续结果均保留在仓库外的本地验收目录。完整既有回归及对应提交的 Linux CI 结果记录在本阶段 PR，不将测试成功代替负责人验收或正式独立 Review。
