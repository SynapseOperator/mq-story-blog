# P2-08A：受保护草稿服务

对应 [Issue #23](https://github.com/SynapseOperator/mq-story-blog/issues/23)。依据 PRD v1.1 §2、§10.1/10.2、§11，仅覆盖 FN-02 权限、FN-08 草稿服务、FN-10 草稿隔离、FN-17 校验与限流；不是编辑器、预览或发布工作流验收。

## 依赖与范围

负责人于 2026-10-29 放宽开发启动条件，允许从 PR #18 的已核实提交 `c12e17725ae1dddcc0d53357a6c76f10f62e64ae` 创建 Stacked PR。base 为 `feat/p2-05-admin-boundary`，main 仍为 `30ccf87cd59f23a1f749b7843badca9ae80e829a`。PR #18 仍须独立安全 Review；没有 Review Exception 或合并授权。其权限实现和历史 SQL 不由本增量修改。

PR #20/#22 未引入本分支。四份演示故事及场景、羽毛信、登录窗口保持不变。公开读取/分享 HTML、RSC、metadata 的联合验收待依赖集成，不能把现有演示首页冒充已验证的数据库公开路由。

## 四个 HTTP 接口

| 接口 | 输入 | 成功响应 |
| --- | --- | --- |
| POST `/api/admin/stories` | `{kind,title,content}` | 201 `{story}`；Location 为受保护详情 |
| GET `/api/admin/stories?limit=20&cursor=...` | limit 1–50；可选游标 | 200 `{items,nextCursor}`，无正文 |
| GET `/api/admin/stories/[id]/draft` | UUID，无查询参数 | 200 `{story,draft:{title,content}}` |
| PUT `/api/admin/stories/[id]/draft` | `{expectedVersion,title,content}` | 200 `{story}`，包含提交后 version |

`story` 摘要仅有 `{id,slug,kind,state,version,draftTitle,hasUnpublishedChanges,updatedAt}`。不返回历史修订、内部邮箱、Token 或授权对象。详情只读当前草稿，不能提交任意 Revision ID。支持同等鉴权的无正文 HEAD，其他方法 405；不支持方法覆盖。所有响应（包括错误）为 `private, no-store`，无跨域授权。

分页按不可变 `(created_at,id)` 降序。数据库时间精度为毫秒，base64url 游标保留 ISO 毫秒时间和 UUID；不是授权凭据。重复、未知参数及畸形游标均拒绝。

创建只接受 STAR/CAMPFIRE，不指定星位。slug 由服务端生成 `story-<32位UUID>`，后续保存不能改名。保存可用于 DRAFT/PUBLISHED/WITHDRAWN，只追加草稿，不改变公开版本、状态或星位。唯一篝火冲突返回 409。

正文沿用 v1 段落/图片结构、标题 160 字符、1–200 块、单段 10000 字符和正文 256 KiB 限制；HTTP 实际流式字节上限为 300 KiB，读取时限 5 秒，不占用权限事务锁。只接受 JSON，拒绝压缩或不支持的封包。A 的图片引用只允许仓库已有合成图 `/scene/night-sky.webp`，不下载、上传或扩大外域来源；媒体管理留给 P2-09。客户端不得传入 slug、state、slotId、任何 Revision 指针或权限字段。

固定错误：400 `DRAFT_VALIDATION`；404 `DRAFT_NOT_FOUND`；409 `DRAFT_CONFLICT`/`DRAFT_INVALID_STATE`；413/415/405 对应大小、格式、方法；身份、Origin/代理、限流沿用 `ADMIN_*` 401/403/429；数据库/配置/ACL 或未知异常统一 503。不得回显驱动错误或输入文本。404 的对象存在性查询仅在通过管理员检查后发生。

## 同一授权事务

请求纯输入校验 → `withAdmin`（当前数据库 Session、Grant→User→Session 锁、角色预检）→ 草稿列权限预检 → `createStoryOperations(tx)`/`createAdminDraftReader(tx)` → DTO → 提交。

`operations.ts` 不持有根 PrismaClient，不开连接或嵌套事务。原 `createStoryService(client)` 工厂仍包装同一操作，供已有生命周期测试/内部调用；管理 HTTP 禁止使用这个另开事务的工厂。发布/选位等方法保持仅内部可用，未增加对应 HTTP 路径。

保存先 INSERT 不可变 Revision，再按 id/version/state 原子 CAS 更新草稿指针。败者抛出，整个事务回滚，不留下孤立修订。`DraftOperationError` 是固定枚举的 `AdminAccessError` 子类，借用既有错误出口穿过 `withAdmin`；必须等事务回滚后才映射 400/404/409。没有改 PR #18 的鉴权实现，也不信任调用者传入 status/message。未知错误仍拒绝为 503。

保存已持有共享授权锁时，撤销等待提交；撤销提交后的新保存会重新检查并失败。撤销先获得排他锁时，保存等待并重新检查授权。权限判断与写入不能拆成两个事务。

网络丢失不等于回滚：客户端应保留输入，受保护地重读 version 确认结果，不自动重复 POST/覆盖保存。真正编辑器的输入保留、保存期间新编辑与旧响应竞态留待 P2-08B；A 没有创建编辑器 UI。

## 数据库最小权限

没有 Schema 或迁移变化；001→002→003→004 原文件保留。创建以参数化 SQL 明确列清单，避免 ORM 显式写默认 state/slot/version。状态 DRAFT、version 0、空公开指针与空星位由原数据库默认和约束保证。

| 对象 | runtime 所需权限 | 不授予 |
| --- | --- | --- |
| story | SELECT；INSERT(id,slug,kind,draft_revision_id)；UPDATE(draft_revision_id,version,updated_at) | state/published_revision_id/slot_id 的 INSERT/UPDATE，身份修改，表级写、DELETE、DDL |
| story_revision | SELECT；INSERT(id,story_id,title,content) | UPDATE/DELETE、表级写 |
| star_slot | SELECT | 所有写入 |
| 管理员/认证/审计对象 | 保留 P2-05 既有边界 | 不增加授权、凭据维护或审计伪造能力 |

`scripts/admin-drafts/privileges.mjs` 是显式测试配置器，仅允许精确命名的本次隔离库；先调用原 P2-05 基线，再按列扩展并用实际 runtime 复核。它不在应用启动时执行，不创建生产角色，扩展失败回滚到受限基线。`draft-privileges.ts` 每次事务核对有效列权限（含 PUBLIC/继承），拒绝缺失、额外列/表级权限、MAINTAIN 和转授权能力。

列权限限制数据库连接的写入范围，不代替 HTTP 身份校验，也不是行级保密隔离。运行时连接仍可 SELECT 修订；数据库凭据失陷、生产角色配置、日志/备份权限、HTTPS/代理和独立安全审查仍是正式开放前门槛。Session Token 原值存库的既有限制不变。

合法读写沿用 `/admin-access` 的数据库共享限流。为避免慢请求占用数据库事务，格式/字节校验在此之前；被提前拒绝的畸形或过大请求不消耗这组限流计数。虽有 300 KiB/5 秒边界，正式公网仍需入口连接数、请求速率与体积限制，不能把应用限流等同于完整抗拒绝服务防护。

## 可复现验证

```sh
npm run check
npm run test:db
npm run test:auth
npm run test:admin
npm run test:admin-drafts
```

`test:admin-drafts` 使用已构建的生产服务器，只在指定 `mq_test` 实例创建两个随机临时库与非 owner runtime/maintenance 身份。从空库部署全部历史迁移、重复部署和 drift 检查，执行真实权限/并发/HTTP/HTTPS/日志隔离测试，最后仅清理本次创建的库、角色、进程与 TLS 文件。不重置共享库、不 seed 开发库。

可选浏览器 hook 用 `MQ_DRAFT_BROWSER_MODULE` 指向仓库外的 `runBrowser` 模块，`DRAFT_BROWSER_EVIDENCE_DIR` 指定截图目录。合成凭据只以内存参数传入，不写入截图/录屏/HAR。默认 CI 执行真实 HTTP/HTTPS，浏览器证据单独记录，不能把二者混称。

实际结果和截图在本 PR 验收记录中列出。CI 保留故事、认证、管理员、限流、日志与持久化套件，再新增草稿套件；PR #20/#22 集成后必须保留 `test:public` 与分享回归，重新检查 CI/package.json/日志白名单和工程文档冲突。

### 2026-10-29 Windows 本机结果

Node 24.19.0 / Prisma 7.10.1 / PostgreSQL 18.6。以下命令最终均退出 0：

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | lint、Schema、typecheck、60 项单元测试、生产构建 |
| `npm run test:db` | 31 项基础/生命周期检查 |
| `npm run test:auth` | 35 项 HTTP、8 项证书验证 HTTPS；原认证并发/会话/日志回归 |
| `npm run test:admin` | 3 项 CLI 预检、18 项数据库、20 项 HTTP、4 项 HTTPS |
| `npm run test:admin-drafts` | 12 项数据库、19 项 HTTP、4 项 HTTPS；另验证开关关闭、应用日志隐私及精确清理 |

两个独立空库均执行 001→002→003→004、重复部署及 drift 校验。真实低权限角色能创建/保存草稿；直接 SQL 写 state、published_revision_id、slot_id、历史 Revision、管理员授权和 DDL 均被拒绝。CAS 两个写事务只有一个胜者，失败修订回滚；撤销先后两种锁顺序均实测。测试仅清理本次创建的库/角色，未修改开发内容或 `.env.db.local`。

仓库外生产构建 Playwright/Chromium 156 最终 run-02：桌面 1536×1024、手机 390×844（DPR 2），16 项、12 张截图；真实 Cookie 下四个草稿 API、普通用户拒绝、旧场景/羽毛信、嵌套账号、留言草稿确认、焦点及 reduced-motion 通过，无意外浏览器错误或敏感响应。浏览器使用本地测试证书，未部署正式 HTTPS；它是本机检查，不冒称 CI 浏览器测试。截图、脱敏 JSON 留在本机会话证据目录，不提交 Cookie/HAR/密码。

实施中真实发现并修复：原生 SQL 的 Prisma 7 pg 错误包装未映射唯一冲突（曾返回 503，现精确映射 409）；扩展年份游标可越过 JavaScript 日期检查（现输入层返回 400）；测试自身误授权限探针撤销后未恢复列权限（现精确恢复后重验）。首轮失败保留在任务工具记录，不以最后成功掩盖失败过程。

这些结果不是负责人技术验收或独立 APPROVED。仍待 PR #18 安全评审、依赖同步，以及本 Draft PR 的技术/安全 Review。P2-06/P2-07 公开 HTTP、HTML/RSC/metadata/分享联验和 P2-08B 的真实编辑内容保留检查尚未完成。
