# P2-06：公开故事读取与阅读器接入

对应 [Issue #19](https://github.com/SynapseOperator/mq-story-blog/issues/19)，依据 PRD v1.1 §5.1–5.5、§6、§7 与 §11。分支直接来自 main `30ccf87cd59f23a1f749b7843badca9ae80e829a`，只使用已合并 P2-03/04；待独立 Review 的 P2-05 / PR #18 未合并，不依赖其管理员权限模块。

## 数据路径与公开契约

```text
首页静态场景外壳
  → GET /api/stories（公开摘要）
  → 稳定星位 / 唯一篝火 / 移动端目录
  → 点击入口
  → GET /api/stories/{稳定故事 UUID}（一篇公开正文）
  → 同一个羽毛信组件，真实 DOM 内容块
```

首页 HTML/RSC 不包含故事正文，客户端也不预加载全部文章；只有点击或明确重试时读取对应正文。四份旧 `synthetic-demo` 文章保留为隔离演示/测试夹具，默认页面不导入它们，不将数据库错误解释成“请显示演示内容”。

| 入口 | 成功响应白名单 | 失败 |
|---|---|---|
| `GET /api/stories` | `{ stories: [{ id, slug, title, entry, slotId? }] }` | 查询参数 400；数据库/数据校验异常 503 |
| `GET /api/stories/[id]` | `{ story: { id, slug, title, content } }` | 无效/不存在/DRAFT/WITHDRAWN 统一 404；数据库异常 503 |
| `HEAD` | 相同状态/缓存策略，无正文 | 同上 |
| 其他方法 | 无写能力，405 + `Allow: GET, HEAD` | 不代理内部写服务 |

`entry` 为 `star` 或 `campfire`；仅 star 带稳定 `slotId`。正文保持 P2-03 的 `{ version: 1, blocks: [...] }`，仅支持段落及图片，段落可标记 normal/emphasis/strong。DTO 不包含 draft/published revision 指针、编辑版本号、历史修订、内部时间戳、账号或权限信息。slug 此时只是公开身份字段，不建立正式分享页面或浏览器历史行为，P2-07 再处理。

`createPublicStoryReader` 每次使用一条参数化 SQL：`Story.state=PUBLISHED`，同时 JOIN `published_revision_id` 与该 revision 的 `story_id`。状态、归属与正文在同一 PostgreSQL 语句快照内读取；不能先取 draft，再靠前端判断是否可见。所有输出显式重建白名单，并复用受限内容校验。星位只接受目前已验收的 `star-1/2/3` 与对应 scene key；发现未映射的公开星位拒绝该查询，不能擅自移动到其他位置或静默遗漏。

## 缓存与下架边界

两条 Route Handler 显式 `force-dynamic`、`revalidate=0`，响应 `Cache-Control: no-store, max-age=0` 与 `Pragma: no-cache`。客户端请求同样 `cache: no-store`；模块单例仅复用连接池，不缓存目录、文章或请求状态。

实现依据当前 Next.js [Route Handlers 文档](https://nextjs.org/docs/app/getting-started/route-handlers) 与 [路由配置文档](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config)。本工程未开启 Cache Components；缓存结论还需以生产构建 HTTP 的 no-store、发布更新与下架回归为证据。

下架事务提交后开始的**新公开请求**重新读取 PostgreSQL，不返回旧内容。读信关闭和再次打开移动目录时刷新摘要；读信中不做静默后台换文。已发送的文章、已经在途的响应、用户复制/截图或自行保存的副本不能远程撤回，本任务不作此承诺。

## 阅读兼容与错误处理

- 公开摘要只负责身份、标题与场景绑定。目录和热点共享同一份摘要，按 `slotId` 映射 CSS，过滤/下架不产生重排补位。
- 原 `FeatherLetter` 的纸张层、内部滚动、展开/关闭、焦点、Esc/遮罩和留言草稿确认保留；新增 loading / 错误 / 重试状态，正文抵达后在同一阅读层显示。
- 请求使用 AbortController 和当前请求身份检查；重复点按不叠加阅读层，关闭与新阅读不会接收旧请求的结果。加载失败不会伪装成正文成功，重试只读取当前入口。
- 段落与图片按原内容块顺序渲染，不拉伸纸纹或无限增高阅读层；图片各自有失败状态，不阻止正文与关闭。文本仍由 React 转义，不解释为 HTML。
- 公开版本没有日期、作者、引言或落款等专门字段，因此不从创建时间或正文猜测这些元信息。原有演示数据有自己的虚构字段，二者明确区分。
- 空库/无已发布文章时没有可点击故事星，篝火景物继续存在，目录显示空状态。数据库/网络错误显示错误与重试，不回退演示文章，也不把原始 SQL/连接串交给浏览器。
- 点赞与留言继续是明确“不发送”的本地原型，不因文章来自数据库而声称业务服务已实现。

## 本地运行与隔离验收

构建与 `npm run check` 不连接数据库。普通 `npm run dev` / `npm start` 从启动进程读取 `DATABASE_URL`，未配置或目标不可用时，场景正常呈现、公开读取显示错误。

需要查看已迁移目标库时，由操作者通过既有秘密管理或被忽略且权限受控的本地环境文件，把 `DATABASE_URL` 安全注入进程；公开只读预览保持 `MQ_AUTH_ENABLED=false`。不要把连接串值放入命令行、README、测试截图或日志。应用不自动读取 `.env.db.local`、不自动迁移或 seed。若使用既有 `dev:auth` / `start:auth` 工具，其认证开关、Origin 和开发库行为仍遵循 [AUTHENTICATION.md](AUTHENTICATION.md)，不能为查看公开故事而开放正式注册。

```sh
npm run check
npm run test:db
# test:public 运行真实 Next 生产服务器，先成功完成上面的生产构建。
npm run test:public
```

`test:public` 校验现有 `mq_test` 本机/CI 实例，仅以它作为控制连接，创建本轮随机 `mq_test_public_<随机值>` 数据库与独立非特权只读角色。依次从空库执行历史 001→002→003、重复部署、migration status 与 schema drift 检查；不新增迁移，也不修改历史 SQL。

合成夹具在这个临时库内通过已有生命周期服务创建：两篇公开星星、一篇公开篝火、未发布草稿、下架故事以及已发布文章的未发布修订和旧历史版本。长文含多张配图和故意失效配图，另有无图短文。测试期间将现有合成夜空素材复制为唯一临时静态文件供真实 HTTP 加载，结束后只删除本轮精确文件；不提交重复素材。

测试范围包括公开白名单/内容隔离、真实空库 HTTP、按需正文、错误参数/方法、显式发布更新、下架立即生效、稳定星位、权限拒绝与恢复，以及实际 PostgreSQL 连接拒绝。HTTP worker 使用只有三张故事表 SELECT 的临时身份；数据库错误/连接详情和私有正文标记不能出现在应用日志。所有失败输出保持固定阶段/错误类别。

浏览器可用显式 `MQ_PUBLIC_BROWSER_MODULE` 与 `PUBLIC_BROWSER_EVIDENCE_DIR` 接入同一临时库和生产服务器；helper 导出 `runBrowser`，接收公开夹具与本轮 visibility / DB 权限故障回调。截图及报告在仓库外，浏览器测试不能带 Cookie、真实账号或私密资料进入 Git。

结束时只清理本轮创建的进程、数据库、角色和图片，不 FORCE DROP、不停止现有开发任务、不 reset/清空已有库、不 prune/删除卷。CI database Job 在生产构建后执行同一 `test:public`。具体命令退出码、检查数量、截图及 CI 链接以本次 PR 的实际执行记录为准；本说明本身不代表测试或视觉验收已经通过。

## 本轮本机验证（2026-10-29）

- Windows / PostgreSQL 18.6 / Prisma 7.10.1：`npm run check` 退出 0，46 项单元测试、lint、Schema、类型检查及生产构建通过。
- `npm run test:db` 退出 0，31 项数据库/生命周期检查；`npm run test:public`（带外部浏览器 hook）退出 0，15 项公开 PostgreSQL/HTTP 检查，以及真实空库、连接拒绝、迁移重复部署、drift 与只读身份检查。
- 生产构建 Chromium 156：20 组浏览器检查、12 张截图，覆盖 1536×1024、390×844、320×568、reduced-motion、长文/多图/坏图/无图、草稿/焦点、延迟响应、空库、下架与错误重试；无意外运行错误或非公开响应。
- 既有 `npm run test:auth` 退出 0：35 项 HTTP、8 项 HTTPS；认证默认关闭的公开读取场景与受控认证测试分别执行。
- 首轮新测试出现期望键排序错误，已修正；浏览器故障用例曾因等待 networkidle 超时，改为明确等待真实 503/200 与 DOM 状态后整组通过。原失败报告保留在仓库外，不把失败当作已通过。
- 浏览器脚本、JSON、截图在本机 `mq-p2-06/run-03` 证据目录，不提交凭据、Cookie、HAR 或测试资料。CI 结果及提交 SHA 在 Draft PR 中单独记录；以上不代表负责人产品验收或独立 APPROVED Review。

## 保留限制

本项不提供故事写入、发布/下架、管理页面、上传、分享 URL、真实点赞或留言服务，不自动录入任何真实内容。当前库若为空，需要保持真实空状态；不能为填满三颗星而自动插入文章。

临时只读身份验证不等于生产运行身份已配置。既有正式开放门槛继续保留：认证默认关闭或受控启用、Session Token 原值存储风险、最小权限部署、正式 HTTPS/可信代理、日志/备份保护及独立安全审查。P2-05 独立 Review 不因本项开发而跳过，P2-06 完成 Draft PR 后等待产品与独立评审，不自动合并或进入 P2-07。

本轮临时角色的 SELECT 是表级权限，仍可读取表内非公开修订；PUBLISHED/公开版本隔离由上述服务端查询保证，不构成数据库凭据失陷后的保密边界。正式运行身份是否进一步采用受限视图或其他策略，应随生产最小权限审查落实。
