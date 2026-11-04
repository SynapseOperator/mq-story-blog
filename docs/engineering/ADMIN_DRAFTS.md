# P2-08A：受保护草稿服务

对应 [Issue #23](https://github.com/SynapseOperator/mq-story-blog/issues/23)。依据 PRD v1.1 §2、§10.1/10.2、§11，仅覆盖 FN-02 权限、FN-08 草稿服务、FN-10 草稿隔离、FN-17 校验与限流；不是编辑器、预览或发布工作流验收。

## 依赖与范围

本分支最初按负责人 2026-10-29 授权从 PR #18 的 `c12e17725ae1dddcc0d53357a6c76f10f62e64ae` 创建 Stacked PR。2026-11-03，PR #18/#20/#22 均经匹配最新提交的独立 APPROVED 后普通合并；main 为 `42ef1821dd03881388f0bcc14c288a89a2e3dbe3`，quality/database 成功。本 PR 现以 main 为 base，同步后新增真实草稿/公开分享联合测试，不修改管理员权限实现和历史 SQL。新提交须重新取得独立 Review 和 CI，不能沿用 `aeeda411` 的旧审批。

公开读取/分享实现来自已合并的 PR #20/#22，首页使用真实公开摘要，场景、羽毛信与登录窗口保持不变，不回退演示数据。联合测试在同一个生产构建 HTTP 进程中使用受保护草稿 API 和匿名公开 API/HTML/RSC/metadata，不以两个独立套件通过代替真实联验。PR #26 编辑器尚未合并，本轮仅准备后续同步方案，不开发 P2-08C 或其他功能。

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
npm run test:public
```

`test:admin-drafts` 使用已构建的生产服务器，只在指定 `mq_test` 实例创建两个随机临时库与非 owner runtime/maintenance 身份。从空库部署全部历史迁移、重复部署和 drift 检查，执行真实权限/并发/HTTP/HTTPS/日志隔离测试，最后仅清理本次创建的库、角色、进程与 TLS 文件。不重置共享库、不 seed 开发库。

可选浏览器 hook 用 `MQ_DRAFT_BROWSER_MODULE` 指向仓库外的 `runBrowser` 模块，`DRAFT_BROWSER_EVIDENCE_DIR` 指定截图目录。合成凭据只以内存参数传入，不写入截图/录屏/HAR。默认 CI 执行真实 HTTP/HTTPS，浏览器证据单独记录，不能把二者混称。

实际结果和截图在本 PR 验收记录中列出。CI 同时执行故事、认证、管理员、草稿、公开读取/分享、限流、日志、事务与持久化套件。PR #18/#20 已合并，原 Stacked parent 的触发条件收敛为 main；PR #26 仍由其自身分支工作流覆盖 P2-08A base，未删除测试或降低检查要求。

联合测试通过现有管理员 HTTP PUT 保存已发布故事的新标题/正文，再经受保护 GET 确认草稿实际保存，并检查公开版本指针、slug 和星位保持不变。匿名目录、ID/slug API、分享 HTML、RSC 和 bot metadata 只能看到原公开版本；下架后的新请求不得继续暴露原公开标题或正文，新草稿也始终不能泄漏。仅使用测试 runner 创建的隔离合成故事和现有低权限 runtime，不添加权限、路由或发布 API。

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

以上为原 `aeeda411` 的历史结果，后续已获负责人技术验收和匹配该提交的正式独立 APPROVED。本次 main 同步及新增联合测试的实际结果、CI 和新审批另行记录，不能由旧验收推定。P2-08B 编辑器与最新 main 的联合验收、产品视觉验收仍未完成；生产最小权限、正式 HTTPS/代理、日志备份及整体安全审查门槛继续保留。

### 2026-11-03 main 同步与联合验收

同步 `42ef1821dd03881388f0bcc14c288a89a2e3dbe3` 后，Windows / Node 24.19.0 / npm 11.17.0 / Prisma 7.10.1 / PostgreSQL 18.6 上实际执行，最终退出码均为 0：

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | lint、Schema、typecheck、72 项单元测试、生产构建 |
| `npm run test:db` | 31 项基础/生命周期检查 |
| `npm run test:auth` | 35 HTTP + 8 HTTPS |
| `npm run test:admin` | 3 CLI + 18 DB + 20 HTTP + 4 HTTPS |
| `npm run test:admin-drafts` | 12 DB + 20 HTTP + 4 HTTPS，包含新增真实受保护保存与匿名公开/分享隔离联合测试 |
| `npm run test:public` | 15 项公开 PostgreSQL/HTTP + 10 项分享检查；通过仓库外 hook 执行 32 项真实浏览器回归 |

草稿套件继续验证两个隔离空库的 001→002→003→004、重复部署、drift、列级权限、CAS、回滚、撤销锁顺序及应用日志隐私。联合测试首轮及两次定位运行失败于测试 transport 不自动跟随 Next.js 的 RSC 307 规范化跳转；之后仅在新测试中验证同源、同路径且唯一 `_rsc` 查询并跟随一次，保留最终 200/RSC/no-store/隐私断言。`test-admin-drafts-rerun3.log` 全套通过，前三份失败日志保留；没有修改应用、鉴权或通用认证 transport 来消除失败。

Chromium 156.0.8078.4 的 32 项回归覆盖桌面 1536×1024、390×844 和 320×568、触屏及 reduced-motion；包含直达/刷新/前进后退、关闭返回首页、草稿确认、嵌套登录、长文、错误重试、空库与下架。18 张生产构建截图及脱敏报告在本机 `mq-pr24-main-sync/run-01` 证据目录，意外运行错误和隐私违规均为 0。Browser 插件 Skill 未列出，按工程工作流复用已有 V1 Playwright；未测试其他浏览器或实体手机，不将本机浏览器证据称为 CI 浏览器测试。

场景/阅读器/登录、管理员授权实现、Schema 和历史 SQL 均未修改。测试只清理各自临时数据库、角色、图片和进程，不写开发故事或真实账号。此次同步产生新 head，须重新匹配 CI 与独立 APPROVED；旧 `aeeda411` 审批不覆盖本提交。PR #26 尚未同步本次增量，也不因此视作已经完成编辑器联合验收。

### 2026-11-03 媒体 main 同步

PR #30 与 #32 已分别经匹配 HEAD 的独立审批后普通合并为 `10439fc`、`d945871`，两次 main quality/database 均成功。本分支以普通 merge 同步媒体 main，保留草稿领域、withAdmin、CAS、列权限及原有公开分享隔离用例，不提前接入 #34 的 v2 编辑和公开图片读取。

- 草稿测试精确断言全部 001→005，历史 SQL 原字节保留；媒体套件继续验证 004 旧库升级、checksum 和 Prisma drift。
- `test:media:upload` 的原纯媒体库仍执行 6 项 ACL、2 项恢复检查。另一个隔离 HTTP 库先配置草稿权限，再配置媒体权限；新增 3 项组合测试，证明同一运行身份满足两套精确列矩阵、草稿保存与素材更新可以共同回滚，同时直接 SQL 发布、选位、改写历史引用、素材身份及管理员授权仍被拒绝。
- 上述组合测试及接线来自临时基线 `02c33cb8` 的明确集成差异，仅复用测试；没有整体合入临时基线或复制未合并编辑器/预览代码。未来 #34 整理时仍须核对其他基线接线，不能机械重放 C 提交。
- CI 保留媒体 main 的全部安全/数据库/公开分享/持久化步骤，并加入草稿测试；删除已完成 P2-06/P2-09A 的临时 PR base 过滤。下游 B/C 须保留各自分支过滤与浏览器套件。

本次同步产生新 HEAD，`1f898372` 的 APPROVED 不能代替新提交审批。#26/#28 后续分别同步与重验，编辑器视觉签收独立于私有预览；生产权限、HTTPS/代理、Token 存储、日志备份和正式安全审查门槛继续保留。当前提交的实际测试与 CI 链接记录在 PR #24，避免把历史结果归到新 HEAD。
