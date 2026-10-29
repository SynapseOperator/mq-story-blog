# P2-07：故事分享与浏览器历史导航

对应 [Issue #21](https://github.com/SynapseOperator/mq-story-blog/issues/21)，依据 PRD v1.1 §6、§7、§11 及 FN-11/12/13。P2-06 / PR #20 已获负责人验收，但仍待 SnorkelingBreather 正式独立 Review、尚未合并。本分支从 `feat/p2-06-public-stories` 的已验证提交 `648d9e5360951bd0c027aae410306469f8b5d2d7` 创建；P2-05 / PR #18 不属于本项依赖，也没有合并或修改授权。

## 分享路径与公开隔离

`/stories/[slug]` 使用 Story 已有且不可变的 slug；标题更新、数组排序和星位变化不重新生成链接。P2-03 数据库身份触发器继续保护 slug，本项不修改 Schema 或历史迁移，也不增加分享 token、真实故事或写 API。

| 路径 | 行为 |
|---|---|
| `/` 中的故事星、篝火、移动目录 | 更新地址并打开同一个羽毛信，按 slug 读取正文 |
| `GET /stories/[slug]` | 动态返回 MQ 场景和阅读器外壳；RSC 只传 URL slug，不传正文 |
| `generateMetadata` | 只查询 PUBLISHED 的所属公开版本摘要；公开标题加 MQ 后缀，非公开或故障使用通用标题和描述 |
| `GET /api/stories/by-slug/[slug]` | `{ story: { id, slug, title, content } }`；只读、按需正文 |
| slug API 的 HEAD/其他方法 | HEAD 同状态无正文；POST/PUT/PATCH/DELETE/OPTIONS 拒绝 405 |

ID API 与目录仍保留 P2-06 契约。slug 查询同样使用单条参数化 SQL，JOIN `published_revision_id` 与 revision 所属 `story_id`，并限制 `Story.state=PUBLISHED`。私有标题、草稿、下架正文、未发布编辑与历史版本不能进入 API、HTML、RSC 或 metadata；metadata 不读取正文。

分享页面统一返回 **HTTP 200 的场景外壳**，以便非公开/不存在或数据库故障时仍能使用同一封信的友好提示、重试和关闭。正文 API 才区分无效/不存在/非公开的 404、数据库不可用的 503；无效查询参数为 400。这个选择不声称页面自身返回 HTTP 404。页面和 metadata 始终 noindex，正式 SEO/搜索收录另行审查。

## 缓存和更新

分享页及 slug API 显式 `force-dynamic`、`revalidate=0`；正文响应和客户端请求 no-store，metadata 每次查询公开摘要，不建立跨请求的标题缓存。发布更新后新请求取得新公开版本，下架提交后的新请求不再取得原公开标题/正文。已经送达的页面、在途响应、截图或用户保存的副本不能远程撤回。

参考 Next.js 当前 [原生 History API 集成](https://nextjs.org/docs/app/getting-started/linking-and-navigating#native-history-api) 和 [metadata 文档](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)。metadata 可能流式出现在 HTML 中，因此验收检查完整 HTML/RSC，另覆盖 Twitterbot 的阻塞 metadata 路径；不能只检查 `<head>`。

## 导航与阅读状态

`src/lib/stories/story-history.ts` 管理本组件创建的历史条目。history.state 的应用字段只包含链标识、索引、路径和是否从首页进入；不存文章、留言、密码或会话。使用 Next 支持的 `pushState/replaceState` 集成：初始化时保留已有 state 并仅增加应用字段、不改变 URL；之后改变 URL 时只传应用字段，由 Next 保留其内部状态，不读取或自行构造私有路由标记。

- 从首页打开故事只增加一条历史记录；重复点击不能叠加阅读器或重复 push。返回首页后前进可重开该故事，并重新读取公开版本。
- 对同一条受控历史链的后退/前进，先回到原记录再复用阅读器关闭流程。存在留言时显示既有确认框；取消不 push/replace，不重建信纸，保留当前滚动、草稿及预览。确认关闭后再完成原遍历。
- 从首页打开后，关闭使用已知的首页前驱；外部直达或无法证明前驱为 MQ 首页时，关闭只 replace 当前记录为 `/`，不意外返回外部站点。用户自己按浏览器后退仍尊重外部/未知历史，不人为制造首页前驱。
- 展开/收起中或嵌套账号窗口打开时，不切换文章；先保持当前阅读上下文。关闭、Esc、外围暗区与站内历史导航共用同一草稿保护。
- 请求取消与当前请求身份检查继续阻止过期响应串文。确认离开后，演示草稿和点赞不持久化；再次阅读重新获取公开内容，不使用 history 中的正文副本。

跨文档后退、刷新或关闭标签页无法使用站内 dialog 拦截。只在有未提交留言时注册 `beforeunload`，由浏览器提供通用确认；页面不能定制提示文案，通常需要先有用户交互，手机切换应用后被系统终止时也不保证触发。参见 [MDN beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)。本项不把草稿写入 localStorage，也不承诺浏览器崩溃或关闭后的恢复。

## 验证方式

```sh
npm run check
npm run test:db
# 先完成生产构建，再使用既有隔离 PostgreSQL runner。
npm run test:public
```

`test:public` 保留 P2-06 的 15 项检查，并增加 `scripts/public-stories/sharing-checks.mjs`：slug 查询/DTO、页面/RSC/metadata、草稿/下架/不存在、非法输入、HTTP 方法、未发布修订、发布更新与稳定 slug、下架后新请求、真实数据库权限故障恢复。全部在随机临时数据库和只读 HTTP 账号中验证，测试故事在浏览器步骤前恢复，不向开发库 seed。

历史控制器单元测试验证 push/replace/traversal 数量、取消和确认、外部前驱及重复操作；它不能代替真实浏览器。现有外部浏览器 hook 用相同隔离库验证直达、刷新、首页打开、前进/后退、关闭、草稿、账号子窗口、慢响应、失败、下架、桌面/手机与 reduced-motion，截图和诊断保存在仓库外。真实退出码、检查数量、提交 SHA 和 CI 链接由本轮 PR 记录；本说明不表示尚未运行的检查已通过。

### 2026-10-29 本机验证

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 退出 0；lint、Prisma Schema、TypeScript、54 项测试及 Next.js 16.4.2 生产构建通过 |
| `npm run test:db` | 退出 0；真实 PostgreSQL 18.6，31 项基础/生命周期检查通过 |
| `npm run test:public`（含浏览器 hook） | 退出 0；原有 15 项公开检查、新增 10 项分享检查通过；隔离空库应用 001→002→003，无迁移漂移 |
| `npm run test:auth` | 退出 0；35 项真实 HTTP、8 项证书验证 HTTPS；Session、CSRF、共享限流、容量分类与日志回归通过 |
| 生产页面 Playwright Chromium 156 | 32 项通过，18 张截图；1536×1024、390×844、320×568；无意外运行错误或非公开响应泄露 |

浏览器工具插件不可用，本轮复用 V1 已缓存的 Playwright/Chromium，没有下载新依赖。可通过 `MQ_PUBLIC_BROWSER_MODULE` 指定外部验收脚本、`PUBLIC_BROWSER_EVIDENCE_DIR` 指定产物目录，再运行 `npm run test:public`。本机脚本与证据保留在 `C:/Users/33684/.codex/visualizations/2026/10/21/01a15e37-d65f-7060-8479-b1bdf80a6d26/mq-p2-07/`：`browser-regression.mjs`、最终 `run-02/browser-results.json` 和截图。

首轮 `run-01` 暴露关闭后焦点恢复早于历史提交的问题：目录刷新移除了刚获得焦点的热点。现等待历史提交、目录刷新完成后恢复焦点，`run-02` 完整复测通过；失败证据保留。预期的 404、故障测试 503、受控关闭认证 503 与主动请求取消单独记录，不计为意外错误。技术验证不代替本项产品/独立 Review 验收。

## 依赖合并与边界

PR 暂以 `feat/p2-06-public-stories` 为 base。PR #20 经独立 Review 且另行授权合并后，核对其实际合并方式和 main，再调整本 PR base；重新检查差异只含 P2-07、迁移顺序和 Schema 一致，重新运行 check、数据库/公开 HTTP、认证必要回归、浏览器与 CI。若提交发生变化，原审批不能冒充新提交的有效 Review。

不自动合并本项、PR #20 或 PR #18，不开发编辑/发布/上传/点赞/留言审核或部署。认证继续默认关闭或受控启用；Session Token 原值存库、生产运行身份、HTTPS/可信代理、日志备份及独立安全审查门槛保留。手机标题单字换行是负责人确认的非阻塞后续视觉优化，本项不修改已验收布局。
