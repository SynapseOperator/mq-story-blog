# P2-08C：管理员私有羽毛信预览

关联 [Issue #27](https://github.com/SynapseOperator/mq-story-blog/issues/27)，对应 PRD v1.1 §6/§10.1/§10.2/§11 及验收清单 FN-08 的“预览”子项。发布、图片上传和星位选择不在本增量中。

## 依赖与入口

本分支基于 P2-08B 同步提交 `3f161bf519321edf209e5ee706f731a670e8cd2b`，其 Windows 全量回归和 [Quality #39](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41611604713) 已通过。PR 暂以 `feat/p2-08b-story-editor` 为 base；PR #24 的 `1f89837`、PR #26 的 `3f161bf` 仍未合并。main 是 `42ef1821dd03881388f0bcc14c288a89a2e3dbe3`，不能将未合并的编辑功能视作 main 功能。继续开发许可不构成 Review Exception；本轮不合并任何 PR。

在受保护的 `/admin/stories` 编辑一篇草稿，点击“预览羽毛信”。新建但未保存、已保存后继续编辑、保存中及发生冲突/结果未知的本地工作稿都可预览；已知权限失效或正在切换详情时禁用入口。关闭回到原编辑器，不跳转 MQ 首页。

## 数据与展示路径

`StoryEditor.current.working → createPreviewSnapshot → FeatherLetter(private-preview)`。

点击事件读取当时的 working，逐字段复制并冻结 title、块顺序、段落样式、图片 src/alt/caption 以及未保存标记。预览不使用 pending/confirmed 替代当前文本，不执行保存校验或规范化；空标题/空正文仍可打开，用解释性占位显示，不把占位写回工作稿。快照不携带故事 ID、slug、版本、编辑器块 key 或账号数据。

快照仅存在于客户端内存，不 dispatch 编辑器保存动作，不执行 POST/PUT、创建 Revision、改变 expectedVersion、URL、history 或本地存储。保存响应仍按原状态机确认其发送快照；它不能重新挂载阅读器、改变已打开的预览快照或把较新的工作稿标记为已保存。

`FeatherLetter` 使用判别模式，公开模式默认不变；预览不伪装为 published Story。纸壳、旧纸九宫格、羽毛、邮戳、动效、内部滚动、图片失败降级和结构化图文循环共用同一实现。预览仅显示“管理员私有预览 · 未发布”，未保存时注明“包含未保存修改”；不挂载点赞、留言、账号、分享或留言确认组件。

背景是已有 `Landscape` 的非交互展示，不挂载 `ScenePage`，不获取目录、正文或公开分享路径。它与 dialog 位于编辑器主元素的兄弟层，避免后台通用按钮样式影响信纸。关闭按钮、Esc 和背景点击沿用阅读器开合及 reduced-motion 处理；原生模态层阻止背景编辑输入，既有滚动锁保持生效。

编辑器保持挂载。关闭时恢复最近文本控件、选区方向、控件内部滚动及本次打开时的页面滚动；不触发离开确认，不清空 dirty/pending/confirmed。稳定的 onClosed 回调避免保存 ACK 导致阅读层重新初始化。已显示的内存文字无法被服务端远程撤回；任何新的私有数据请求仍逐次经过原管理员鉴权。

## 权限与隐私

没有新增 Route Handler、Server Action、数据库模型、迁移、发布接口或数据库权限。管理员页面与四个草稿 API 的 `withAdmin`、锁顺序、CAS 和列级权限原样保留；预览不是授权替代方案。

私有预览不进入 `/stories/[slug]`、公开 API、HTML/RSC/metadata、日志、history.state 或 localStorage/sessionStorage。浏览器测试只在隔离库使用合成账号/故事；不保存 Cookie、HAR、trace、密码或真实私稿产物。截图是明确标注的合成演示内容，用于本次人工验收。

## 可复现验证

```sh
npm run check
npm run test:db
npm run test:auth
npm run test:admin
npm run test:admin-drafts
npm run test:public
npm run test:admin-editor
npm run test:admin-preview
```

预览套件复用已有草稿 runner 的随机 PostgreSQL 空库、受限 runtime、维护身份和本地测试 TLS，先执行原 12 DB / 20 HTTP / 4 HTTPS，再运行生产构建 Playwright。测试专用只读 `snapshotDatabase` 回调检查版本、公开指针和 Revision 数，没有对应 HTTP 入口。测试结束只清理本轮记录的数据库、角色、图片与进程。

`DRAFT_BROWSER_EVIDENCE_DIR` 可指定仓库外截图目录；默认使用系统临时目录。报告只记录测试名、固定错误类别、源码行号或指纹，新增私稿 canary 同时进入父 runner 的应用日志隐私断言。CI 保留全部既有套件并增加 `test:admin-preview`，不上传带账号状态或私有请求正文的调试产物。

## 2026-11-03 本机验收

Windows 生产构建、隔离 PostgreSQL 18 与 Chromium 156 的最终验证均退出 0：

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | lint、Prisma generate、类型检查、94 项单元测试、生产构建通过 |
| `npm run test:db` | 31 项数据库测试 |
| `npm run test:auth` | 35 HTTP + 8 HTTPS |
| `npm run test:admin` | 3 CLI + 18 DB + 20 HTTP + 4 HTTPS |
| `npm run test:admin-drafts` | 12 DB + 20 HTTP + 4 HTTPS；真实受保护保存后公开版本隔离 |
| `npm run test:public` | 15 公开读取 + 10 分享隔离 + 32 浏览器检查 |
| `npm run test:admin-editor` | 原草稿数据库/HTTP 套件 + 21 编辑器与 4 独立篝火浏览器检查 |
| `npm run test:admin-preview` | 原草稿数据库/HTTP 套件 + 14 私有预览浏览器检查、6 张截图 |

预览检查包含数据库版本/Revision/公开指针不变、无写请求、真实并发更新引发的 409、保存 ACK 在预览打开期间到达、失败图片、匿名公开 API/HTML/RSC/metadata canary 隔离、日志和存储隐私、连续开关、长文内滚、焦点/反向选区恢复，以及 1536×1024、390×844 触屏、320×568 触屏与 reduced-motion。最终公开/编辑器回归使用同一最终构建；不把构建切换期间的中间运行作为交付证据。

首轮 lint 的测试文件 `structuredClone` 全局声明错误已改为 `globalThis.structuredClone`，未放宽 lint；另修正了输入框失焦后再滚动页面时的预览返回位置，并补真实浏览器断言。初次失败和中间运行记录保留在仓库外证据目录，不覆盖或冒充最终结果。

本机完整日志、JSON 与截图位于本次 Codex 的 `mq-p2-08c/c-preview` 和 `mq-p2-08c/c-final` 证据目录；GitHub CI 结果见 Draft PR。未验证其他浏览器或实体手机。技术验证不代表负责人视觉验收或正式独立 Review；生产运行身份、HTTPS/代理、日志备份与整体安全审查门槛仍保留，Session Token 仍原值存库。不开始 P2-09/P2-10。
