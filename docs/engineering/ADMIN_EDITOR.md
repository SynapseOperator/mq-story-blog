# P2-08B：管理员结构化故事编辑器

关联 [Issue #25](https://github.com/SynapseOperator/mq-story-blog/issues/25)。需求来源：PRD v1.1 §10.1/10.2/11，FN-02 后台、FN-08 文章编辑、FN-10 草稿隔离与 FN-17 终端适配；实现范围由负责人本次 P2-08B 授权限定。

## 依赖与入口

本分支最初从 PR #24 的 `aeeda4115530a030960ed469d9c1e564304c73fa` 派生，2026-11-03 同步其最新 `1f898372a2f6660778930a0a8c05885505bd53c9`，仍以 `feat/p2-08a-admin-drafts` 为 base。main `42ef1821dd03881388f0bcc14c288a89a2e3dbe3` 已包含 P2-05/06/07；PR #24/#26 尚未合并。同步提交须新的 CI 与匹配提交的正式独立 Review，旧 APPROVED 不自动覆盖；本次允许继续编码，不是 Review Exception 或合并授权。

`/admin` 经原权限检查后提供 `/admin/stories` 链接。新页面使用可信认证 Origin 和真实请求头调用 `withAdmin`，只返回界面框架。未授权时显示拒绝页面（页面 HTTP 200，不声称为 401/403）；四个 API 实际返回 401/403/503 等状态。页面动态渲染，静态 metadata/noindex、private/no-store、禁止嵌入，不序列化私人标题、正文、Session 或授权数据到 HTML/RSC。

实际列表、详情和写入仍逐次走 [P2-08A 四个 API](ADMIN_DRAFTS.md)，在同一个 `withAdmin` 事务中操作。没有新增写接口、数据库权限、Schema 或 Migration；不改变授权函数、会话、安全审计与现有内容验证。

## 编辑与保存

界面提供有界分页、新建 STAR/CAMPFIRE、标题、段落排序/删除及普通/强调/加粗样式、现有 `/scene/night-sky.webp` 合成图片和说明。没有上传、私有羽毛信预览、星位选择、发布、下架、恢复或审核。

`src/lib/admin-editor/` 定义严格 DTO、纯状态转换和请求客户端；`src/components/admin-editor/` 负责 DOM 与独立作用域 CSS。纸色编辑区是表单，不是第二套羽毛信正文渲染器。

| 状态 | 含义与处理 |
| --- | --- |
| working | 当前本地编辑；内容块稳定 key 保持输入焦点，不发往服务器 |
| pending / lastSent | 发出时规范化并冻结的快照，附 requestId、故事身份、expectedVersion |
| confirmed | 服务器确认的版本与该次发送内容；成功响应不替换 working |
| 400 | 保留全部输入，允许用户修正后手动保存 |
| 409 | 保留本地稿与旧 CAS；读取服务器详情后人工选择，不自动覆盖 |
| 503、超时、断网或不可解析成功响应 | 标记结果未知，不重发写入；先读取核对 |
| 401/403 | 保留当前本地输入，取消在途读取、禁用后续写入，要求重新登录/进入 |

保存期间允许继续输入，但不能切换故事或重复保存；旧 ACK 只确认发送快照。新建 POST 结果未知时禁用再次新建，刷新受保护列表后核对最近发送内容、候选详情与稳定 slug，再显式绑定已有故事，或明确离开。不按同标题自动判定同一故事。

保存已有故事时，重新读取后可选“保留本地并继续编辑”（只接受新 CAS，仍需手动保存）或“载入服务器版本”。读取另一故事期间有新输入则取消切换；读取期间禁止保存，迟到响应不能把新输入或在途写入丢掉。

## 离开、隐私与响应式

未保存/冲突/结果未知时，应用内切换和返回 MQ 使用确认对话框；取消恢复原控件、选区与滚动。跨文档离开/刷新使用 `beforeunload`，不承诺浏览器崩溃恢复。只把已确认故事 UUID 写入 `?story=` 并使用 `replaceState`，不增加每篇稿的浏览历史，不把私人文本放 URL/history/localStorage/sessionStorage。

390px/320px 保持单列、可收起手稿列表和可见的新建操作；编辑区内控件不横向溢出，reduced-motion 关闭本编辑器的过渡。现有首页、羽毛信、登录样式与数据适配不变。

授权撤销不等于从已显示的浏览器内存抹除文字。保留本地稿是防丢失行为；任何新的真实读取/写入必须由服务器重新授权，bfcache 恢复会重新核验列表权限。正式应用运行身份、HTTPS/代理、日志备份与安全审查继续是开放门槛。

## 可复现验证

```sh
npm run check
npm run test:db
npm run test:auth
npm run test:admin
npm run test:admin-drafts
npm run test:public
npx playwright install chromium
npm run test:admin-editor
```

`test:admin-editor` 复用草稿集成 runner，在项目测试 PostgreSQL 下创建独立随机数据库和最小权限临时身份，从空库执行 001→004。普通流程复核原草稿 DB/HTTP/HTTPS 测试；浏览器只通过生产构建访问合成账号。第三个空库专门验证 UI 首次创建篝火及重复拒绝，不删除前一套用例保留的单例。最后仅清理本次记录的数据库、身份、进程和 TLS 文件，不清空现有开发/测试数据。

浏览器用例包含真实 API 保存、两个窗口 CAS 冲突、提交成功后丢弃响应、延迟读取与保存中继续编辑。400/503 和部分网络错误使用明确的传输故障注入，正常成功路径及并发/权限/约束均使用 PostgreSQL，不以 Mock 数据库替代。HTTPS 使用本地测试 CA，浏览器仅允许该隔离环境的自签名证书；真实生产证书链仍待部署阶段验证。

证据目录默认在系统临时目录，可用 `DRAFT_BROWSER_EVIDENCE_DIR` 指定。可用 `MQ_PLAYWRIGHT_EXECUTABLE` 指向 V1 已有 Chromium；CI 使用锁定 Playwright 1.64.1 与安装的 Chromium。没有 HAR、trace、Cookie/storageState 或真实凭据产物；失败记录只包含步骤、源码行号、固定错误类型/数字及合成页面截图。

CI 同时保留 quality、story、auth、admin、admin-drafts、public/分享及编辑器真实浏览器套件。编辑器浏览器 hook 在自身隔离库中发布一篇合成 star-3，用其真实身份验证返回 MQ、分享地址、羽毛信及留言草稿保护；不再假定首页回退四份演示文章。不会修改开发库，也不删除原单例篝火测试。草稿保存与匿名公开 API、HTML/RSC/metadata 隔离联合用例来自 PR #24，继续执行。

技术检查与产品视觉验收分别报告；本编辑器视觉仍待负责人评审。

### 2026-11-03 上游同步验证

同步 PR #24 的 `1f89837`，合并 CI/工程说明冲突，保留 A 的事务和列级权限以及 B 的完整编辑器实现。浏览器 fixture 改为使用本次隔离库中真实发布的合成 star-3，没有更改生产状态机、UI 或历史迁移。

Windows / Node 24.19.0 / npm 11.17.0 / PostgreSQL 18.6 上，`npm run check`（88 单元测试及生产构建）、`test:db`（31）、`test:auth`（35 HTTP + 8 HTTPS）、`test:admin`（3 CLI + 18 DB + 20 HTTP + 4 HTTPS）、`test:admin-drafts`（12 DB + 20 HTTP + 4 HTTPS）、`test:public`（15 公开 + 10 分享）及 `test:admin-editor` 均实际退出 0。后者复跑草稿套件，并执行 21 组编辑器及 4 组独立空库首次篝火浏览器验证；另通过公开/分享浏览器 32 组。

Chromium 156 本机证据在 `mq-p2-08c/b-sync`：编辑器 18 张、公开阅读 18 张生产截图，包含 1536×1024、390×844、320×568、触屏、reduced-motion。未发现意外运行错误或敏感响应；所有临时库/角色/图片/进程按本次作用域清理。浏览器证据不是产品视觉签收，旧 head 的 APPROVED 也不覆盖新同步提交。新 CI 及正式 Review 以 PR #26 最新记录为准。

负责人允许验证通过后从同步分支独立实施 Issue #27 私有羽毛信预览；本次 B 同步不包含 C，不合并 PR #24/#26，不使用 Review Exception。

### 2026-10-29 Windows 本机结果

Node 24.19.0、Prisma 7.10.1、PostgreSQL 18.6、Playwright 1.64.1 / Chromium 156.0.8078.4。以下最终命令均退出 0：

| 命令 | 真实结果 |
| --- | --- |
| `npm run check` | lint、Schema、typecheck、76 项单元测试、生产构建 |
| `npm run test:db` | 31 项基础/故事生命周期检查 |
| `npm run test:auth` | 35 HTTP + 8 证书验证 HTTPS |
| `npm run test:admin` | 3 CLI 预检 + 18 DB + 20 HTTP + 4 HTTPS |
| `npm run test:admin-editor` | 原草稿套件 12 DB + 19 HTTP + 4 HTTPS；21 组编辑器浏览器 + 4 组全新库篝火浏览器 |

最终 run-05：1536×1024、390×844、320×568 触屏/reduced-motion，18 张合成生产页面截图；浏览器运行错误、意外失败及内部字段泄露检查均为 0。135 次实际页面 fetch 在响应 clone 中检查隐私，只回传审计元数据；完整 HTML/RSC/API 的隔离探针另行执行。正常写入、冲突与丢失成功响应后的核对均访问真正 PostgreSQL。三个独立空库迁移 001→004、重复部署与 drift 检查通过，首次 UI 篝火在 SQL 中确认为唯一 CAMPFIRE、DRAFT、slot_id IS NULL。运行结束清理了本次所有临时库、角色和进程。

本轮修复过两个实际审读发现的编辑竞态（迟到详情覆盖新输入、权限失败后旧读取填回数据），并为前者加入延迟 GET 自动回归；补全段落/样式控件的稳定无障碍名称。run-01 的控件定位失败、run-02 的响应读体挂起以及 run-03 的未能完成响应审计均保留在本机证据和任务记录。run-02 为解除挂起终止了本次拥有的浏览器，明确不作为通过证据；最终改用浏览器 fetch 克隆审计后完整重跑，未关闭应用鉴权或隐私检查。没有以截图或功能检查已跑通代替整套命令通过。

Linux 首轮 Quality #31 在取消离开后的上下文断言失败，记录保留；测试现显式等待下一动画帧的焦点/选区恢复，并继续执行原精确断言，没有更改应用或放宽验收。Windows run-05 整套重跑退出 0。

GitHub CI 的最终链接与精确提交记录在本 PR；本机结果不代替 Linux CI，也不代替负责人视觉验收或独立 Review。
