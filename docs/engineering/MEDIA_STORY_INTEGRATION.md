# P2-09C：受管图片与故事集成

本阶段对应 Issue #33。只使用隔离测试库与合成图片；不开放正式注册、管理员账号或发布接口。上游已合并，P2-09C 本身仍在 PR #34 等待独立评审与合并授权。

## 分支与迁移

独立基线 `02c33cb808e30e6cc948aa30a291d78c1680259e` 的两个父提交为 P2-08C `5249c39640e084cc74f4a7989590241b2e19681e`、P2-09B `59c676e466cd32a58926f76478fb2de91e903e7a`。基线通过 Windows 全套回归和 [Quality #43](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41643971936) 后，才创建 C 功能分支。

PR #24/#26/#28/#30/#32 现已正式合并；main 为 `ab2d5b56902b597ef03c13148241efa67fe47174`，[quality/database CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41770461689) 均成功。main 包含上述两个父提交，且与 `02c33cb8` 的树差异只有 CI 和五个文档：生产代码、测试、Prisma、依赖锁文件及 Next 配置完全一致。基线中的组合权限测试、005 清单和 Sharp/Playwright 接线没有遗漏。

因此保留 C 原分支，以普通 merge 同步 main 后再将 PR #34 的 base 改为 main。对 main 的差异仅为 C 增量及说明，不需 cherry-pick 或新建替代 PR。临时 integration 分支的 CI 触发已移除；新提交重新执行全部回归并请求独立 Review，本轮不合并 #34。

历史 001–005、Prisma Schema 均不修改。空库全部迁移与真实 004 旧库升级至 005 由 `test:media` 验证，含历史迁移 checksum 和 schema drift。C 无新迁移；沿用 005 的 READY 外键、内容校验、引用投影与不可变保护。

## 内容及编辑状态

- v1 保留原有 src 图片与公开契约。v2 图片只能包含 `type/assetId/alt/caption`；拒绝 src、Key 或远程 URL。正文边界按 PostgreSQL `jsonb::text` 字节长度校验。
- 新故事使用 v2。旧故事可原样保存；选择新素材时，明确提示逐一替换旧图。临时混合内容可在本地预览，但禁止保存，不能静默删除或自动上传旧图片。
- 上传继续使用原始字节 POST `/api/admin/media` 与随机 UUID `Idempotency-Key`，XHR 进度只代表发送字节。100% 后显示处理状态，只有服务端 READY 才能插入。结果未知保留原 UUID，通过 GET 查状态，不自动重新 POST。
- 素材列表有界分页，只有 READY 可选择。素材 DTO 新增实时 `publishedStoryCount`，只计当前公开引用的去重故事数，不返回其他故事身份/标题，也不是访问授权的缓存开关。
- 插入前重新读取状态，回调同时核对编辑器实例、选择请求和目标块。只改 working；sent 快照、confirmed version、expectedVersion 及未保存离开保护沿用原实现。
- 保存使用既有四个草稿 API，在同一个 `withAdmin` 事务内 INSERT Revision，再 CAS 更新 Story。005 触发器自动维护引用；应用不 INSERT/UPDATE/DELETE 关联。失败回滚 Revision 和引用。
- 私有预览从内存快照派生 `/api/admin/media/{assetId}/content?variant=display`，不保存、不发布、不改 URL 或浏览器存储。复用 FeatherLetter / StructuredBlocks 与原信纸；每次图片请求仍须管理员鉴权。

## 公开图片权限

新增 GET/HEAD `/api/stories/{storyId}/media/{assetId}`，仅展示图，无 query/variant 参数。每次单条 SQL 同时验证：

1. Story 为 PUBLISHED。
2. 当前 publishedRevision 确实属于该 Story。
3. 该 Revision 的真实不可变引用包含 assetId。
4. 素材为 READY。

读取文件不持有数据库事务；核对实际字节数与 SHA-256 后，再执行同样的完整公开查询。私有、历史、错误故事配对和下架均返回 404；存储、数据库或完整性故障返回固定脱敏 503。响应不含路径/Key/Revision；服务端错误日志只有固定事件码。

成功与失败均 no-store，HEAD 也执行文件完整性及权限验证但无 body。条件请求不产生 304，Range 不产生可缓存部分响应，不重定向到静态文件；Next optimizer 继续只允许既有静态素材目录，拒绝管理/公开媒体 API。

公开正文仍按需加载当前版本，v2 DTO 保留 assetId；共用渲染器按已验证 storyId 派生媒体路径。v1 分享及旧合成图片继续可读。旧 v1 的静态资源不是本阶段新受管资源，不声称能够追溯撤销它们。已交付给访客的字节不能收回；检查后已开始的响应也不能承诺远程抹除。

## 数据库权限

| 对象 | 运行身份 | 维护/迁移身份 |
| --- | --- | --- |
| Story/Revision | 延续受控草稿列级写入、读取；无发布/历史修订写权 | 仅隔离测试中用于生命周期夹具 |
| StoryRevisionAsset | C 增加 SELECT；无直接 DML | 005 安全函数从内容生成引用 |
| MediaAsset | 延续 B 的受控 PENDING/READY/FAILED 与元数据权限 | 不扩大 |
| AdminGrant/授权函数 | 不新增权限 | 延续既有离线维护边界 |

双能力角色按 `applyAdminDraftDatabasePrivileges` 后 `applyMediaDatabasePrivileges` 配置；测试真实直接 SQL 越权失败，不能只验证服务端按钮。生产身份未授权配置，正式开放仍需独立安全、HTTPS/代理、日志/备份与最小权限验收。

## 验证入口

保留 `check`、`test:db`、`test:auth`、`test:admin`、`test:admin-drafts`、`test:admin-editor`、`test:admin-preview`、`test:media`、`test:media:upload`、`test:public`。

新增 `npm run test:media:stories`：保留 B 原始测试，再在第三个随机空库和独立私有文件目录执行 C。覆盖真实上传/v2 保存、并发 CAS/回滚、原公开版保留、跨故事复用、更新/下架/恢复、GET/HEAD/缓存/优化器、错误闭合、低权限、公开 HTML/RSC/metadata 及生产 Chromium 图文操作。`MEDIA_STORY_EVIDENCE_DIR` 可指定仓库外证据目录，输出仅合成截图和脱敏结果；不保存 Cookie、密码、HAR 或数据库凭据。

CI 保留全部套件并新增图文联合步骤。Windows 文件系统特性与 Linux 不同，平台不适用用例按原安全测试说明分别报告，不把跳过等同验证通过。负责人已签收原 `0e4c585` 的技术、安全与视觉；本轮同步不改 UI，新提交仍需 CI 和独立 Review。

### main 同步后的最终验证

本次整合保留全部 C 代码和测试，没有复制或重新挑选上游提交。相对已验收的 `0e4c585`，唯一新增产品修复是关闭素材库时的焦点竞争：旧的下一帧恢复任务可能在新输入已聚焦后把焦点拉回正文。现在新的 input/textarea/select 焦点优先，原有选区和滚动恢复路径保留；没有改 CSS、信纸或场景。

浏览器测试增加图片说明、题注和原段落值断言，并通过暂存关闭事件的动画帧回调，确定性验证“新控件聚焦后，旧回调不得抢焦点”。不使用固定等待或生产测试接口。首次失败保留于仓库外 `mq-p2-09c-main-sync/run-1793765583511`；它是输入位置错误导致的预览 alt 定位超时，并非图片权限或加载失败。

修复后 Windows 最终运行 `final-1793766673025` 的以下命令全部退出 0：

| 命令 | 结果 |
| --- | --- |
| `check` | lint、Schema、类型、生产构建；133 单测中 131 通过、0 失败、2 项既有 Windows 文件系统限制 |
| `test:db` | 31 项 |
| `test:auth` | 35 HTTP + 8 HTTPS |
| `test:admin` | 3 CLI + 18 DB + 20 HTTP + 4 HTTPS |
| `test:admin-drafts` | 12 DB + 20 HTTP + 4 HTTPS |
| `test:admin-editor` | 草稿套件 + 21 编辑器与 4 独立 CAMPFIRE 浏览器检查 |
| `test:admin-preview` | 草稿套件 + 14 预览浏览器检查 |
| `test:media` | 13 DB；001→005 空库、004 升级、校验和与 drift |
| `test:media:upload` | 6 ACL + 2 恢复竞争 + 3 组合权限 + 17 HTTP + 5 HTTPS |
| `test:media:stories` | 上传基础套件 + 14 图文 PostgreSQL/HTTP + 13 浏览器检查，9 张图文截图 |
| `test:public` | 15 公开读取 + 10 分享隔离 + 32 浏览器检查 |

生产构建 Chromium 156 覆盖 1536×1024、390×844、320×568、触屏和 reduced-motion；无非预期浏览器错误或私有响应泄露。Browser 插件不可用，沿用项目锁定 Playwright；未验证其他浏览器或实体手机。权限测试覆盖下架后新的 GET/HEAD 拒绝；返回前二次查询已审查，但没有声称单独验证了“恰在文件 I/O 中途下架”的确定性时序。新提交 CI 与独立 Review 以 PR #34 的实际状态为准。

### 初版本机结果（2026-11-03，同步前）

Node 24.19.0 / npm 11.17.0 / PostgreSQL 18.6 / Prisma 7.10.1 / Sharp 0.35.5；生产构建 Chromium 156.0.8078.4。上述十个既有命令均退出 0；另运行限流、事务等待和数据库日志安全回归，均退出 0。`check` 单元测试 131 通过；既有 Windows 文件符号链接权限与 POSIX mode 两项不适用（junction 真实测试仍运行），Linux CI 必须验证相应 POSIX 用例。

新增联合套件退出 0：14 组真实 PostgreSQL/HTTP、12 组真实浏览器检查；1536×1024、390×844 触屏、320×568 触屏/reduced-motion，共 9 张合成截图，0 个非预期运行错误。涵盖真实上传丢失响应后按原 ID 查验、503/真实并发 409、保存 ACK 迟到仍保留新 working、v1 显式迁移和切换编辑器后的迟到素材确认。

保留最初三次失败记录：测试最初误将 Next 的空响应 RSC 规范化 307 当作最终实体。现只允许同源、同路径、仅 `_rsc` 参数的空跳转，最终 RSC 必须 200、no-store、正确内容类型及私有正文隔离；媒体接口仍不允许跳转。没有放宽生产权限或为测试改 Next 配置。实际 Linux 结果与提交 SHA 记录于本阶段 Draft PR，不能用本机通过代替 CI。
