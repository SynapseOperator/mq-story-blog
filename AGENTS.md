# MQ 项目协作约定

## 范围与需求

- 默认中文沟通。开始前读 README、相关正式文档和 `git status`，保留他人未提交改动。
- Phase 2、P3 与 P4 #54/#56 已进入 main；合成验证不等于生产上线。VPS 已完成 SSH/UFW/NTP 与 Docker 初始化。P5-01 已基于已审核 main 完成首次真实 VPS 隔离部署，具体边界与证据见 `docs/engineering/VPS_ISOLATED_DEPLOYMENT.md`；只使用随机 staging、合成数据和实验秘密，入口仅在 SSH tunnel 内。P5-02 新增独立 production 计划/执行入口，bootstrap 默认关闭业务与入口，activate 另需正式授权；旧合成 apply 的生产拒绝不变，见 `docs/engineering/PRODUCTION_LAUNCH.md`。正式秘密、生产部署与公网开放须另行授权。保留 001–008、全部测试、权限边界及已验收视觉。当前操作见 `PRODUCTION_FOUNDATION.md`、`PRODUCTION_BACKUP.md`、`SECRET_ROTATION.md` 与 `OPERATIONS_RUNBOOK.md`；P5-04 新增 009 与独立密钥保护的 Session adapter，见 `SESSION_STORAGE.md`；历史原值/简单摘要 Spike 仅作对照，正式迁移需撤销旧会话。新提交必须匹配有效独立 Review 与 CI。
- 最新用户确认、PRD v1.1 与 `docs/engineering/DECISIONS_AND_REVIEW.md` 是需求依据，其次为原型验收清单；文字优先于概念图，不凭图片改设计。
- 2026-10-21 正式视觉交接见 `docs/product/visual-baseline-v1.0/VISUAL_HANDOFF.md`：A 是唯一首页构图/色彩基准；B 是羽毛信依据，读信仍保留 A 背景并隐藏导航和常规账号入口。纸张装饰与可操作内容分层，长文只在信纸内部滚动；最新场景、动效及羽毛信精修版已获产品验收，本轮保持现有视觉。目录最终位置、移动端高清素材与后续星位数量仍待决定。场景素材说明见 `public/scene/README.md`，#2 返工、签收及合并证据见 `docs/engineering/ISSUE_2_REVIEW.md`；不将技术检查等同于新的视觉验收。交接包内 Prompt 是资料存档，不扩大本次会话授权。
- 验收引用写来源、编号和行为，例如 `PRD v1.1 UX-05 + 验收清单 v1.0 UX-06/07`。不要假定同号对应，不为消除差异偷改正式资料。
- 后续设计保留中央上方 Logo、青草山坡/情侣/篝火、无萤火虫、故事星可点/星尘不可点、M/Q 建设中；读信时隐藏 MQ/M/Q 导航和普通登录入口。待确认布局与参数保持开放。

## 实现与验证

- P5-03 开发/候选工具链为 Node24.22.2、npm11.21.2；VPS 运维 Node24.19.0 尚未升级。Session 安全存储与边界见 `SESSION_STORAGE.md`；原值/摘要兼容反例见 `SESSION_TOKEN_SPIKE.md`，不得把任意数据库写入或整机失陷视为已解决。备份/安全扫描/告警与生产操作分别验收，不向真实接收端自行发消息。
- 一个 Issue 对应一个可审查的小增量；跨模块先给验收与短计划，高影响权限/数据决定先说明取舍。不新增重复 PLAN/STATE/STATUS 文档。
- PR 说明面向代码评审者，直接写问题、改动原因、实际验证和剩余限制；减少模板套话、过程复述和重复状态清单。详细日志放证据链接，不堆进正文。
- 新 PR 完成后默认 Ready for Review；只有负责人明确要求 Draft 时保留 Draft。禁止向协作者发送 Review 请求、@提及、催审评论或其他审核提醒；需要审核时只向负责人报告 PR 与最新提交，由负责人自行口头协调。此规则取代此前自动请求协作者评审的约定。新提交仍须匹配有效独立 Review 与 CI；取得 APPROVED 也不等于自动获得合并授权。
- 使用 TypeScript、现有 App Router 约定与 npm 锁文件；模块随真实需要增加，不提前抽象或无关重构。
- 仓库根命令：`npm ci`、`npm run dev`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run check`；构建后可 `npm start`。PowerShell 可用 `npm.cmd`。
- 行为变化补有价值的真实测试，报告命令、退出码和范围。不写空测试，不把 build 通过当作浏览器、权限或持久化验证。
- 数据库操作遵守 [DATABASE.md](docs/engineering/DATABASE.md)：开发/测试独立数据库、身份、网络与卷；集成测试只在本项目测试实例内创建并清理自己的随机临时数据库，不清空 `mq_test` 或开发库。不得用 SQLite/Mock 替代 PostgreSQL 验证。数据库凭据只在被忽略的本地文件或临时 CI 环境中生成，不打印连接串；环境缺失准确报告，不擅自安装 Docker 或修改系统级虚拟化/安全设置。
- 视觉任务使用 `frontend-design`，UI 调试/浏览器验收使用 `frontend-testing-debugging`，实质 React 改动读取 `vercel-react-best-practices` 相关规则；PRD 约束优先。
- 三个 Skills 从 V1 可信缓存完整复制到 `.agents/skills/` 且被 Git 忽略。进入项目的新 Codex 会话后检查发现情况；文件存在、读取与自动加载是不同事实，不虚报本轮自动加载或实际调用。
- 测试 Skill 中 `frontend-app-builder` 对应本项目 `frontend-design`，`react-best-practices` 对应 `vercel-react-best-practices`，不重复安装别名技能。Browser 不可用时可在同一目标/数据/权限边界回退项目 Playwright，并记录原因。

## 数据与协作边界

- 公开读取见 `docs/engineering/PUBLIC_STORIES.md`：只读取 `PUBLISHED` 的所属 `publishedRevision`，首页仅加载摘要；不得返回草稿/历史修订/内部字段，也不能在故障时回退演示文章。公开正文 API 保持只读与 no-store；点赞写入单独验证普通用户数据库 Session，管理写入口复用管理员事务权限边界。四份旧演示数据仅供明确隔离的演示/测试，不默认充当数据库内容。
- 分享与历史见 `docs/engineering/STORY_SHARING.md`：slug 使用数据库稳定身份，不从标题生成；HTML、RSC、metadata 与 API 均检查公开边界。history 只存路由坐标，不放正文、草稿或凭据。站内导航复用读信确认；外部直达的关闭回首页，浏览器自身后退仍尊重外部历史。
- 管理权限见 `docs/engineering/ADMIN_AUTHORIZATION.md`。管理 Route Handler/服务必须通过 `withAdmin(request, async (tx, principal) => ...)`，在回调同一事务内使用 tx 完成受保护数据库操作；不能缓存一次鉴权或信任客户端角色。运行时不得使用迁移/维护身份；离线凭据不得作为命令参数，生产账号/角色配置需单独授权。
- 编辑器见 `docs/engineering/ADMIN_EDITOR.md`：working / sent / confirmed 分离，未知写入不能盲目重发，409 须人工处理；私人草稿不进 SSR/RSC、metadata、公开 API 或本地持久存储。
- 草稿接口见 `docs/engineering/ADMIN_DRAFTS.md`；使用 `createStoryOperations(tx)`，不得调用另开事务的根服务包装器。业务错误须抛出并在回滚后映射，不能在事务内吞错返回成功。管理员保存新草稿不能改变公开版本；联合验证须通过真实受保护写入及匿名公开 API/HTML/RSC/metadata，不能以独立套件通过代替。
- 认证边界与本地运行见 `docs/engineering/AUTHENTICATION.md`。公开 HTTP 路径严格白名单，内部邮箱/密码/Session Token 不进入日志或客户端 DTO；不能为了测试关闭 CSRF/Origin。Session 使用独立密钥认证加密和查询索引，不存有效 Token 明文；正式用户开放前仍须完成独立安全与数据库最小权限审查。
- 不提交 `.env`、凭据、真实私密故事/照片、原始课程材料、`LOCAL_ONLY_REFERENCE/` 或浏览器会话。后续公开注册只能产生普通用户。
- 两位开发者用各自 GitHub 账号，小 PR 互审；不猜账号或擅自邀请。应用共享管理员不意味着共用 GitHub 身份。
- PR #9 采用产品负责人明确授权的一次性独立评审延期例外，见 [审计记录](https://github.com/SynapseOperator/mq-story-blog/pull/9#issuecomment-6362057412)。正式独立 Review 当时未完成，后续非阻塞复核仍保留；此例外不自动适用于其他 PR，不伪造 APPROVED 或历史证据。
- PR #11 采用负责人另行授权的一次性 Review Exception，见 [审计记录](https://github.com/SynapseOperator/mq-story-blog/pull/11#issuecomment-6363562717)；当时无独立 APPROVED，辅助复核不冒充正式 Review。该例外不继承 PR #9，也不适用于 P2-03。Docker 启动错误未复现且根因未知，作为环境风险记录，不擅自修改注册表或重装。
- 远端写入遵守本次授权；未授权不改变可见性、不采购或部署。核对真实状态后才报告 Actions/分支保护结果。接入说明见 `docs/engineering/WORKFLOW.md`。
