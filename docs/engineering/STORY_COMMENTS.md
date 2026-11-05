# 留言提交与审核（P2-12A）

对应 [Issue #43](https://github.com/SynapseOperator/mq-story-blog/issues/43)、PRD v1.1 §09 / FN-05/06/07/17 和本轮负责人授权。本阶段只有服务端。信纸里的演示留言不调用这些接口；真实留言 UI 和审核页面留待 P2-12B。

## 合同

所有响应使用 `private, no-store`、`nosniff`，不发送 304。正文为纯文本，去首尾空白后 1–500 个 Unicode 码点，不接受 HTML/Markdown 渲染、回复树、附件或额外字段。JSON 请求最多 8 KiB，以兼容 500 个使用 surrogate escape 编码的 emoji。

| 路径 | 请求 | 返回 |
| --- | --- | --- |
| GET `/api/stories/[id]/comments` | `limit` 默认20、最大50；可选 `cursor` | `{items:[{id,body,author,createdAt}],count,nextCursor}` |
| POST 同路径 | `Idempotency-Key: UUID`；`{body,identity:"anonymous"\|"account"}` | 202 `{receiptId}`，初次提交进入待审核；重放仅确认曾接收，不表示当前审核状态 |
| GET `/api/admin/comments` | 同上分页；`state` 默认 PENDING，可选 APPROVED/REJECTED/WITHDRAWN；可选 `storyId` | 同分页结构；各项增加 `storyId,state,version,moderatedAt,approvedAt` |
| POST `/api/admin/comments/[id]/moderate` | `{action:"approve"\|"reject"\|"withdraw",expectedVersion}` | `{comment:{id,state,version,moderatedAt,approvedAt}}` |

公开 author 为账号的公开用户名或“匿名访客”，没有 userId、内部邮箱、审核人、Session、IP。分页按 createdAt/id 倒序；count 是符合可见条件的总量，不是当前页条数。后台仅返回审核所需 DTO，不返回内部邮箱或 Token。

匿名提交不需要账号。登录者也可以明确选择 anonymous；选择 account 时，身份只能来自 Better Auth 的数据库 Session。两种身份都从 PENDING 开始。客户端不能提交 userId、审核状态或签名。

相同 UUID（不区分大小写）的摘要在全表唯一，绑定故事、身份和规范化后的正文。同键同内容返回相同 receiptId；换故事、正文或身份返回409。响应丢失时用原 key 重试，不生成新 key。重放回执不返回当前审核状态。每次重试仍消耗限流额度；下架后不再接受重试，返回404。

错误：输入400；账号身份缺少有效 Session 为401；管理员权限/来源拒绝403；无效、草稿、下架或不存在的公开故事404；幂等冲突、CAS 或非法状态409；超限429（Retry-After）；数据库、密钥或权限配置故障503。请求格式/体积也会返回415/413，其他方法405。错误只含固定 code。

## 数据及事务

008 新增 `CommentState`、`StoryComment`（SQL `story_comment`）与独立私有审核密钥表。001–007 保持原样。

`Story 1—N StoryComment`；userId 为空表示匿名，账号留言外键关联 User。留言不依赖 StoryRevision，改标题、发布更新不会丢失历史留言。moderatedBy 关联执行审核的管理员账号，不声称能识别共享管理员背后的实际操作人。

数据库保证：

- submissionKeyHash 唯一，正文1–500码点，初始状态/版本/审核字段固定。
- 插入前锁住 Story 并检查 PUBLISHED；下架与提交按事务先后顺序执行。
- 原正文、身份、Story、创建时间与幂等摘要不可改；本阶段不提供物理删除。
- 只允许 PENDING→APPROVED/REJECTED、APPROVED→WITHDRAWN；每次版本严格加一，保存审核时间/账号。
- 审核函数锁 Grant→User→Session→Story→Comment；独立重验管理员授权、Session 期限、CAS、合法动作。等待行锁后再次核对期限。
- approve 要求故事仍 PUBLISHED；reject/withdraw 可处理已经下架故事。下架不删除留言，恢复公开后仍只显示 APPROVED。

应用边界保证输入 DTO、Origin、身份提取与频率；公开查询在一条 SQL 的同一快照内核对 Story PUBLISHED、所属 publishedRevision、APPROVED 筛选、总数及分页。已在下架之前完成的请求不能从用户设备追回；下架提交后的新请求无缓存地重新检查状态。

提交使用短数据库事务；审核和后台读取直接使用 `withAdmin` 的 TransactionClient。错误必须抛出并回滚，然后映射固定 HTTP code；不在权限事务之外另开审核写事务。CAS 失败不留部分更新。

## 审核权限

沿用006的受限证明模式，但使用独立 `MQ_COMMENT_SIGNING_KEY`（32随机字节，以64位小写hex配置）和 `mq_comment_private.moderation_key`，不复用认证或发布密钥。008没有真实密钥或运行角色授权。

`mq_apply_comment_moderation` 采用固定 `search_path=pg_catalog`，撤销 PUBLIC EXECUTE。专用 NOLOGIN 所有者不能拥有数据库/Schema或超级权限。签名只在已通过 withAdmin 的事务内生成，绑定域标记、数据库、连接身份、当前事务、管理员 Session/User、动作、Story、Comment 和 expectedVersion。函数验证 HMAC-SHA256 及真实权限，拒绝替换参数和跨事务重放。没有通用 SQL、任意字段更新或发布能力。

| 身份 | 允许 | 禁止 |
| --- | --- | --- |
| 运行账号 | 读留言；只插入 id/story/user/body/keyHash；执行两个受控函数 | UPDATE/DELETE/TRUNCATE、插入审核字段、读取密钥、设置角色、直接发布 |
| 审核函数所有者 | 只读留言 id/storyId/state/version/approvedAt 和独立审核密钥；仅改 state/version/审核时间及审核人；调用固定权限锁与 HMAC | 读取正文/作者/幂等摘要、写故事、读发布密钥、登录、授予权限 |
| 迁移/维护身份 | 新迁移与显式配置 | 不能作为应用连接身份 |

`scripts/comments/privileges.mjs` 只允许命名的随机隔离测试数据库；不提供生产自动授权。正式配置必须另行审查。每次写入的权限预检遇到过大权限会拒绝，不以迁移管理员身份掩盖运行账号权限缺口。

## 受控启用、限流与日志

- 留言写默认关闭，需 `MQ_COMMENTS_ENABLED=true`。匿名提交仍使用现有认证的受控配置（MQ_AUTH_ENABLED、Origin 和可信代理），这不要求访客登录。
- 审核另需应用与私有表内一致的独立签名密钥。缺失或不匹配拒绝。普通公开 GET 不需要启用认证或配置签名。
- 复用 AuthRateLimit 的 PostgreSQL 原子计数，使用独立留言桶：每分钟全站120次、来源5次、登录账号8次。并发共享，重试也计数，固定顺序避免锁反序。来源由既有可信代理配置确定；无代理开发环境使用共享来源额度，不信任任意 X-Forwarded-For。
- 桶标识为 HMAC，不存原始 IP。提交正文、Cookie、Token、邮箱和签名不写应用日志；数据库测试强制 terse 错误、禁用失败语句及参数值日志。正式数据库日志、备份、诊断文件的访问控制仍须部署前审查。
- 500码点/8KiB和限流减少滥用；不宣称能抵御所有机器人或分布式攻击。未来若实际流量需要，再评估挑战验证。

## 验证与恢复

`npm run check` 校验类型、Schema、单元测试与生产构建；`npm run test:comments` 在随机 PostgreSQL 数据库/受限角色下跑数据库及真实 HTTP/HTTPS 测试。测试包含匿名/账号、500码点、并发幂等、丢响应、XSS字符串、分页隔离、四种审核状态、伪造/重放证明、撤权、Session过期、下架竞争、CAS、回滚、三层限流、默认关闭和故障503。

所有既有套件保留。媒体升级测试增加007→008，比较历史迁移校验和及已有故事/认证/点赞数据，检查 Prisma drift 和重复 deploy。完整原生备份包含留言和新私有 Schema；恢复后默认撤销全部PUBLIC授权，旧 Session/密钥是备份数据，不构成重新开放审核权限的授权。发布备份测试验证普通应用重新配置和误授 EXECUTE 均不能启用旧审核证明。

本阶段不改UI、不创建真实用户、不公开生产。独立安全Review、生产运行身份、正式HTTPS/可信代理、Token原值存库、密钥轮换与加密备份仍是开放门槛。后续P2-12B必须把正文作为文本DOM渲染，不能使用 innerHTML。

设计依据：[PostgreSQL18 SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html)、[行锁](https://www.postgresql.org/docs/18/explicit-locking.html)、[OWASP XSS输出处理](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)。实际执行结果以本PR证据和CI为准。

## 本轮本机结果

Windows、Node24.19.0、PostgreSQL18.6；使用本任务独立临时容器及随机测试库，没有迁移开发库。以下命令最终退出码均为0：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | lint、Schema、typecheck、生产build通过；178项单元测试中176通过，2项既有平台限制 |
| `npm run test:comments` | PostgreSQL12/12、HTTP21/21、HTTPS22/22；日志隐私、默认关闭与清理通过 |
| `npm run test:db`、`test:media` | 空库001→008、分段旧库升级、历史校验和、drift通过 |
| `test:auth`、`test:auth:limiter`、`test:auth:logs`、`test:auth:transactions`、`test:auth:hash` | 认证、并发限流、数据库日志控制、事务和scrypt回归通过 |
| `test:admin`、`test:admin-drafts`、`test:admin-editor`、`test:admin-preview` | 权限、草稿、编辑器和私有预览真实浏览器回归通过 |
| `test:public`、`test:likes` | 公开版本、分享及点赞/嵌套登录浏览器回归通过 |
| `test:media:upload`、`test:media:stories`、`test:media:lifecycle` | 上传、公开/私有图片、删除及备份恢复通过；保留实际120秒中断恢复用例 |
| `test:publishing` | 发布、浏览器回归以及包含留言的7项联合备份恢复检查通过 |

Windows两项限制是文件符号链接权限与POSIX 0700/0600模式，现有目录junction测试正常执行；Linux CI继续执行对应平台用例。本机没有额外停止现有Compose开发实例执行持久化脚本，CI保留独立Compose停止/重建持久化检查。

首轮留言HTTP测试的一项旧断言把在途撤权预期写成401；既有withAdmin在事务复核失败时明确返回403，已修正断言并完整重跑，没有更改授权逻辑或跳过用例。原失败日志保存在本机任务证据目录，未提交凭据、会话或数据库备份。CI结果与独立Review仍以PR当前HEAD为准。

首轮 [Linux CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41969958330) 在旧点赞浏览器套件的320px reduced-motion初始化处失败：测试在正文异步加载完成前断言页面标题。将原有精确正文标题等待移到页面标题断言前，保留全部断言与原超时；不修改应用/UI，也不重试掩盖错误。失败诊断同时改为明确当前视口，避免显示上一用例名称。最终验证看修正后的HEAD及CI。
