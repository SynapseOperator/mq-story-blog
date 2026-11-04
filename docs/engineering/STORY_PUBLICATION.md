# P2-10：受控故事发布

对应 [Issue #37](https://github.com/SynapseOperator/mq-story-blog/issues/37)、PRD v1.1 §5.2、§5.4、§10.2 和 FN-08/09/10/14。P2-10A 最初从 main `1850610` 独立开发；[PR #36](https://github.com/SynapseOperator/mq-story-blog/pull/36) 随后以普通 merge `4f46e2988d7b5109fa37b53110e7ccbe0ef54d6c` 合并，合并后的 quality/database [CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41812969659) 成功。本分支已通过普通 merge 同步其素材删除、维护与联合备份能力；同步后的验证及独立 Review 单独记录，不沿用旧提交的审批。

P2-10A 后端已通过对应提交的独立 APPROVED，以普通 merge `6e2ac7e4d578dbe6fe527d0334387e40d87cfa7e` 合入 main；[合并后 CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41820043909) 的 quality/database 成功，Issue #37 已完成。P2-10B / [Issue #39](https://github.com/SynapseOperator/mq-story-blog/issues/39) 直接从该 main 开发发布管理界面，不改变下述权限、迁移或生命周期合同。

认证仍受原有开关控制；发布还要求显式设置 `MQ_PUBLISH_ENABLED=true` 和独立签名密钥，缺失时拒绝操作。P2-10B 只使用隔离合成数据与临时密钥，没有生产权限配置或真实内容发布。

## P2-10B 编辑器发布合同

发布区位于现有管理员故事编辑器内，复用下述只读星位接口及四个写接口。STAR 展示候选星位与空闲、草稿预留、已发布、下架保留状态；仅未首次发布的故事可调整星位。CAMPFIRE 使用既有固定入口，不选择普通星位。界面沿用后台深蓝、暖金与米色，主场景、羽毛信和登录窗口不改。

保存、发布、下架和恢复是独立操作：新故事和有本地修改的故事须先保存，才能发布所确认的服务器草稿；已发布故事保存新草稿后显示“发布更新”，原公开版本保持不变。下架需要二次确认，并保留星位。恢复按钮明确使用下架前的公开版本，不发布后来编辑或保存的新草稿。

编辑器继续区分 `working`、发送保存快照和 `confirmed`。发布请求另外记录故事、操作、expectedVersion 及请求身份；保存和发布互斥，但文本输入可以继续。发布成功响应只更新已确认的公开状态与服务器版本，不替换本地文字、内容块标识或已确认草稿正文。请求进行期间的新输入仍为未保存，不能因旧响应成功而被标成全部已保存。

409、断网、503、响应丢失或无法识别的成功响应都保留本地稿；结果未知时不自动重复发布。用户先重新读取服务器草稿与星位状态，再人工选择保留本地内容或载入服务器版本。接受新版本号不等于保存，也不触发发布。权限撤销后停止新的管理操作，同时保留已在当前页面内的输入。

服务端只向页面传递是否显示可用发布控件的布尔开关，不发送密钥；该开关不构成授权。默认关闭时仍可编辑、保存与私有预览。启用后的每一次真实操作继续经过 P2-10A 的 Session、授权、事务 HMAC 和 CAS。浏览器写入只包含 `expectedVersion`，选位额外包含 `slotId`，没有签名、数据库身份、Revision 指针或存储 Key。

验收覆盖隔离 PostgreSQL、HTTP/HTTPS 与生产浏览器中的星位竞争、发布版本冲突、未保存保护、撤权、素材缺失，以及公开 API、分享 HTML/RSC/metadata 和图片 GET/HEAD 随状态变化的行为。新增 UI 测试须保留原发布、备份恢复及其他套件；桌面、390px、320px 触屏/reduced-motion 截图与最终结果记录在本阶段 PR。此处为实现合同，不代表 P2-10B 已通过工程、视觉或独立 Review。

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

## 与联合备份恢复的边界

完整 `pg_dump` 包含 006 的 `mq_publish_private`、非空签名密钥和原有 Session；不能只备份 Prisma 管理的 public Schema。备份目录因此还承担签名密钥保密责任。清单、日志及 CI Artifacts 不得包含密钥或 Token；加密、签名、异地保存和恢复后的密钥轮换仍是正式开放前事项，见 [MEDIA_BACKUP.md](MEDIA_BACKUP.md)。

恢复演练保留归档数据，不通过删除密钥或 Session 假装完成安全恢复。新隔离库先撤销 PUBLIC CONNECT，`pg_restore --no-owner --no-acl` 不恢复原运行身份；导入后清除所有非系统 Schema 的 PUBLIC Schema、表、序列和函数权限，包含 `mq_publish_private` 与其扩展函数。

即使操作者随后只重配普通管理员、草稿和媒体权限，并给应用设置原密钥与发布开关，原 Cookie 也不能发布：运行身份未获发布函数 EXECUTE，恢复后的函数 owner 也不满足受限 NOLOGIN 所有者约定。仅误授 EXECUTE 仍须由数据库函数拒绝。恢复命令不自动配置发布 owner、签名权限或启动服务。生产恢复需要另外授权的权限、密钥与会话处理流程。

## 验证记录

计划检查伪造/替换签名、跨事务/身份重放、过期与撤销 Session、密钥缺失、最小 owner 权限、发布与选位竞争、事务回滚、图片完整性，以及公开 API/HTML/RSC/metadata/图片 GET/HEAD 随生命周期同步。迁移回归保留 004→005，并增加真实 005→006、历史 checksum、v1/v2 内容和引用快照、空库部署及 Prisma drift。

原提交 `93cb78f` 的 Windows 隔离验收：`npm run check` 退出 0，135 项单测中 133 通过、2 项为已有平台文件系统限制；新增 `test:publishing` 退出 0，PostgreSQL 13/13、HTTP 15/15、HTTPS 15/15。测试进程用独立 preload 暂停真实文件读取，在暂停期间完成草稿保存与撤权，再验证发布拒绝；生产代码没有测试接口。桌面 1536×1024、触屏 390×844、320×568 reduced-motion 的真实生产构建浏览器回归通过，未捕获运行错误。这些结果不代表本次同步后的新提交已经通过。

本轮同步后的 Windows `test:publishing` 已退出 0：PostgreSQL 13/13、HTTP 15/15、HTTPS 15/15，新增备份恢复 6/6。真实归档包含密钥及有效合成 Session；恢复后逐项比对数据、执行 migration status/drift，并验证未配置身份不能连接、普通权限不能执行发布或读取密钥、原 HTTPS Cookie 仍不能发布，以及误授 EXECUTE 时函数 owner 检查仍拒绝。生产构建的桌面、390px、320px reduced-motion 浏览器回归通过。完整既有回归与新提交的 CI 以 PR 中对应 SHA 的结果为准。

首轮发布 HTTP 测试的退出请求漏传 JSON `{}`，被已有认证入口拒绝。修正测试合同后完整重跑通过，没有放宽 Origin、内容类型或认证检查；初次失败日志与后续结果均保留在仓库外的本地验收目录。完整既有回归及对应提交的 Linux CI 结果记录在本阶段 PR，不将测试成功代替负责人验收或正式独立 Review。

### P2-10B 验证补充

B 的首轮 `npm run check` 在既有 Windows 素材并发清理测试失败：158 项单测中 155 通过、1 失败、2 项平台限制跳过。该实现和用例此前未因发布界面改动；单独重复原并发用例 20 次，4 次实际出现 Windows `unlink` 的 `EPERM`。保留首轮 `check-01.log` 和逐次失败记录，没有将重跑成功覆盖为首轮通过。

修复仅限 `removeAsset` 的已校验固定目标：Windows 删除竞争报错后，复查同一路径，只有确认 `ENOENT` 才视为并发清理已完成。根目录检查、未知文件和符号链接拒绝逻辑保持不变；仍存在或无法读取的目标继续报错，不全局忽略权限错误，不增加等待或锁。新增显式 `EPERM` 故障注入负向测试，证明目标仍存在时不会吞错；这项测试不冒充真实 Windows ACL 验证，也没有修改系统权限。

修复后原并发用例连续 100 次通过；完整存储单测 15 通过、2 项既有平台跳过，`npm test` 为 157 通过、2 项既有平台跳过，退出码均为 0。两个跳过项分别是当前 Windows 环境缺少文件符号链接权限，以及仅适用于 POSIX 的 0700/0600 检查；目录 junction 用例实际执行。定点 ESLint 和 `git diff --check` 均退出 0。原始失败、`storage-fixed-summary.json`、`storage-fixed-full.log` 和 `storage-fix-all-unit.log` 保存在仓库外验收目录。最终完整 check、集成测试、浏览器与对应提交的 CI 另行记录，以上结果不代表这些检查或 B 的产品视觉验收已完成。

B 首轮 Linux CI `41826489192` 的 quality 成功，database 在既有素材库窄屏测试等待可见缩略图时超时。旧测试只等待卡片有布局，未保证图片进入滚动视口；以实际仓库 CSS 在更短视口中复现了“没有可见图片而一直等待”的条件。测试补上真实滚动和解码，保留全部可见图片加载断言，失败仅输出脱敏几何与加载状态，未改生产 UI。这个负例证明原等待缺少前置操作，但不能单凭原日志断言该次 CI 的精确原因。失败日志保留，完整重跑和新提交 CI 另行记录，不以本机成功代替 Linux 结果。
