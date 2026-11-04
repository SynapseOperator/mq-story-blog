# MQ · Our Stories

MQ 是以共同回忆为主题的个人博客，也是《软件工程—敏捷 DevOps 方法》的课程项目。老师允许以 GitHub 替换华为工具链，个人博客题目与课程工程证据要求仍然有效。

当前分支为 **P2-10A 管理员发布操作后端**（[Issue #37](https://github.com/SynapseOperator/mq-story-blog/issues/37)）。查询预设星位、草稿选位、首次发布、显式发布更新、下架与恢复均通过服务端权限边界；独立 HMAC 凭证绑定事务与操作，运行时无发布字段直接写权限。接口、权限矩阵和威胁模型见 [STORY_PUBLICATION.md](docs/engineering/STORY_PUBLICATION.md)。发布默认关闭，本轮仅使用隔离合成数据。

已同步 P2-09D 合并后的 main `4f46e2988d7b5109fa37b53110e7ccbe0ef54d6c`，[main CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41812969659) 的 quality/database 均成功。素材删除与备份恢复说明见 [MEDIA_LIFECYCLE.md](docs/engineering/MEDIA_LIFECYCLE.md)、[MEDIA_BACKUP.md](docs/engineering/MEDIA_BACKUP.md)。P2-10A / PR #38 保持待独立安全评审，本轮不合并、不部署，不开发发布界面。

私有预览说明见 [ADMIN_PREVIEW.md](docs/engineering/ADMIN_PREVIEW.md)，编辑器状态见 [ADMIN_EDITOR.md](docs/engineering/ADMIN_EDITOR.md)，事务/列权限见 [ADMIN_DRAFTS.md](docs/engineering/ADMIN_DRAFTS.md)。已有公开故事/分享 API、HTML/RSC 和 metadata 仍只读已发布版本，见 [PUBLIC_STORIES.md](docs/engineering/PUBLIC_STORIES.md)、[STORY_SHARING.md](docs/engineering/STORY_SHARING.md)。负责人已完成编辑器与私有预览的技术、视觉及交互签收；本次同步不调整界面。

首页与分享 `/stories/[slug]` 保留原公开版本隔离，保存新草稿不改变公开 API、HTML/RSC 或 metadata。场景、羽毛信、登录与编辑器视觉均保持不变。`test:admin-drafts`、`test:media`、`test:media:upload` 保留真实隔离库、001→006 和组合列权限检查；`test:admin-editor` 验证完整保存状态机、私有数据隔离及桌面/手机浏览器。

保留全部故事、认证、管理员、草稿、编辑器、预览、媒体上传和公开分享测试；新增 `npm run test:media:stories` 联合验证真实上传、草稿、公开图片和生产浏览器。所有测试使用随机隔离库、受限身份和合成数据；认证与媒体仍默认关闭/受控启用。发布与选位接口默认关闭；删除和备份仅通过受控入口执行，不包含生产部署；生产身份、HTTPS/代理、日志备份和独立安全审查门槛不变。

仓库：[SynapseOperator/mq-story-blog](https://github.com/SynapseOperator/mq-story-blog)，创建时已核实为 private。未来如需公开，须重新审查文档、图片、许可与隐私。

## 运行与检查

环境：Node.js **24.19.0**、npm **11.17.0**。使用 npm 与 `package-lock.json`，不混用锁文件。在仓库根执行：

```sh
npm ci
npm run dev
```

普通场景预览打开 [http://localhost:3000](http://localhost:3000)。公开故事需要启动进程持有指向已迁移目标库的 `DATABASE_URL`；没有配置时显示可重试错误，不生成演示文章。仅查看公开故事时保持 `MQ_AUTH_ENABLED=false`，不要把连接串写入命令参数、仓库或日志；具体方式见 [公开读取说明](docs/engineering/PUBLIC_STORIES.md)。真实认证继续按 [认证配置](docs/engineering/AUTHENTICATION.md) 受控使用 `npm run dev:auth` / `npm run start:auth`，该现有工具不自动 seed 故事。其默认地址为 http://127.0.0.1:3000，不能混用不同 Origin。Windows PowerShell 可使用 `npm.cmd`，不修改系统执行策略。

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

`npm start` 需先成功构建；它与开发服务使用相同默认端口，不要同时启动。用 Ctrl+C 停止自己启动的服务。一次执行全部工程检查：

```sh
npm run check
```

`check` 串行执行 lint、Prisma Schema 校验、类型检查、自动化测试和生产构建，任一步失败即返回非零；类型检查与构建会先生成 Prisma Client，但不连接数据库。`npm test` 使用 Node.js 原生测试运行器验证稳定绑定与数据库配置保护，包括故事重排、过滤及篝火身份等行为；CI 同样执行测试。此处为操作说明，实际结果以命令退出码及对应 [Actions 记录](https://github.com/SynapseOperator/mq-story-blog/actions) 为准，测试通过不代替浏览器回归或真实数据库验证。

数据库环境、独立开发/测试入口、迁移与验证命令见 [数据库开发与测试说明](docs/engineering/DATABASE.md)。`npm run check` 可在没有数据库时检查现有前端与认证类型/单元行为；真实 PostgreSQL 迁移、隔离及持久化由独立数据库检查验证，不能用前端构建成功代替。2026-10-23 已按负责人授权安装官方 Docker Desktop（per-user / WSL 2），Windows 本机的迁移、11 项集成测试及 5 项隔离/持久化检查通过；与 Linux CI 的结果、版本差异和启动问题边界分别记录在该说明中。

## 工程与需求入口

- Next.js **16.4.2** App Router、React、TypeScript **5.9.3**、Tailwind CSS 4、ESLint **10.13.0**，由 `create-next-app@16.4.2 --empty` 起步。ESLint 的最小适配与规则缺口见 [工作流](docs/engineering/WORKFLOW.md)。
- `src/app/`：应用路由、MQ 场景首页与 M/Q 建设中页面。保持单仓库模块化单体，按实际需要增加模块。
- `src/components/scene/`：独立场景图层、固定导航与建设中视图；七张本地美术素材及来源、处理与差异说明见 [public/scene](public/scene/README.md)。
- `src/components/reader/`：复用的羽毛信阅读器及样式；纸张与羽毛为独立装饰，文字、图片与控件由 DOM 渲染，素材说明见 [public/letter](public/letter/README.md)。
- `src/lib/stories/`：公开摘要/正文 DTO、客户端读取边界与稳定星位映射；`src/data/` 保留四份合成夹具供隔离演示/测试，默认首页不导入或回退这些文章。
- `prisma/`：基础探针及故事/内容版本/星位 Schema，历史迁移保留，新领域约束使用新增 SQL 迁移；[数据库说明](docs/engineering/DATABASE.md) 记录环境与测试隔离。
- `src/server/stories/`：受限内容块、共享事务操作、内部生命周期工厂与公开只读查询；目录、ID/slug API 和分享 metadata 只读取公开版本。`src/app/api/admin/stories/` 的四个草稿接口复用 `withAdmin` 同一事务；发布/选位接口使用单独受控签名与数据库函数，不授予通用发布字段写权限。
- `docs/product/`：正式 PRD、原型验收与关联图片，保持图片相对路径有效。
- `docs/engineering/`：设计裁决、阶段划分、课程评分映射与工作流。

先读 [PRD v1.1](docs/product/MQ_共享主页_PRD_v1.1.md)、[设计裁决](docs/engineering/DECISIONS_AND_REVIEW.md)、[原型验收清单](docs/product/MQ_交互原型验收清单_v1.0.md)。文字要求优先于概念图。PRD 与清单的 UX 编号不是同一映射，Issue/PR 必须带来源分别引用。

2026-10-21 正式确认的 [视觉交接](docs/product/visual-baseline-v1.0/VISUAL_HANDOFF.md) 替代早期概念图的美术方向：[A 首页](docs/product/visual-baseline-v1.0/assets/A_MQ_home_approved.png) 是唯一场景构图/色彩基准；[B 羽毛信](docs/product/visual-baseline-v1.0/assets/B_MQ_letter_open_approved.png) 是已验收阅读器的视觉依据。两张都是合成参考图，不是页面可直接使用的独立图层；不得将图中 UI 当成真实控件。B 的导航/账号显示痕迹不覆盖 PRD 的阅读隐藏规则，阅读背景必须继续使用 A。

原型可使用清楚标注的演示内容；可点击 UI、静态数据与本地状态不能证明真实认证、权限、持久化、审核和发布已完成。`LOCAL_ONLY_REFERENCE/` 中原始手绘、课程原文及额外 Word 文件不进入 Git，不上传 GitHub。

## 开发协作

两位开发者分别使用自己的 GitHub 账号，以 Issue 明确范围和验收，在功能分支提交小 PR，互审后合并。未来应用内唯一共享管理员与 GitHub 开发账号是两个权限边界；本阶段不创建管理员账号或密码，不邀请未经确认的协作者。

PR #9 因第二位开发者暂时无法 Review，按产品负责人明确授权采用一次性 Review Exception，见 [审计说明](https://github.com/SynapseOperator/mq-story-blog/pull/9#issuecomment-6362057412)。这不是正式独立 Review 已通过；独立复核保留为非阻塞事项，其他 PR 继续按各自授权和评审门槛处理。

PR #11 的技术验收与另一份独立的一次性 Review Exception 见 [审计说明](https://github.com/SynapseOperator/mq-story-blog/pull/11#issuecomment-6363562717)。合并时无独立 APPROVED Review，不能把辅助复核描述为双人审批；该例外不适用于 P2-03。Docker 启动错误根因未明，保留为已记录环境风险，不擅自改注册表或重装。

任务开始先读 [AGENTS.md](AGENTS.md) 并核对 `git status`；Skills 接入与权限路径见 [工作流](docs/engineering/WORKFLOW.md)。按 [课程 11 项评分映射](docs/engineering/COURSE_DEVOPS_RUBRIC.md) 积累真实证据，不补造历史。

本分支以 main 为 base，独立审查 P2-09D 增量。历史阶段文档保留原验收记录，当前操作以本文及生命周期/备份手册为准。目录位置、移动端高清素材与手机长标题排版仍属于后续事项，本轮不更改已验收界面。

已完成的静态场景检查、浏览器覆盖、初版返工过程与最终签收见 [Issue #2 验收记录](docs/engineering/ISSUE_2_REVIEW.md)；其中签收前的“待审”文字属于历史快照。

## 场景与阅读器原型操作

首页仅为已发布、绑定稳定星位的故事显示可点击故事星，支持鼠标悬停标题、键盘焦点与单次触屏点按；已发布的唯一 CAMPFIRE 故事提供篝火入口。没有公开篝火故事时，景物与基础动画仍保留，但没有无效读信控件。所有入口与移动端辅助回忆目录使用同一公开摘要并复用羽毛信；目录的位置和外观仍是原型参数。

故事星用常驻的暖金四角星芒及薄光环区别于底图星点，最暗闪烁阶段仍保持可见；悬停/聚焦进一步增强。高密度竖屏选择原图的无损 WebP 编码，减少草地与银河纹理的压缩损失；未改变构图或生成新美术。原图分辨率、景深与首次加载体积的边界见 [素材说明](public/scene/README.md)。

- `src/data/demo-stories.ts`：保留四个稳定 ID 和 `synthetic-demo` 来源标记，包含合成标题、虚构日期、正文与配图；《把日常写成诗》用于长文阅读检查，不含真实回忆或照片。`demo-bindings.ts` 单独按故事 ID 指定稳定星位及篝火身份，不依赖数组下标。
- `src/lib/stories/story.ts`：保留演示阅读契约，并接入真实公开段落/图片块；不捏造数据库未存储的日期、作者、引言或落款。`scene-catalog.ts` 将稳定逻辑 slot 映射到既有 CSS 位置，重排或过滤故事不重新分配其他故事的位置；服务端同时检查数据库星位映射。
- `landscape.tsx`：背景/前景位移包装层、同层故事星与触区、独立火焰/暖光、局部草叶遮罩；按传入的稳定 slot 渲染现有位置。当前三个预设星位及其响应式位置不代表最终数量或星位策略。
- `use-scene-motion.ts`：单个指针订阅与按需 rAF 平滑位移；触屏禁用视差，系统减少动态效果时关闭循环运动和视差，入口仍可操作。
- `scene-page.tsx`：固定 Logo/导航/账号入口、阅读器入口状态及辅助目录。M/Q 保持建设中，不提供故事控件或循环动画。
- `src/components/reader/feather-letter.tsx`：原生模态阅读层、内部滚动、草稿关闭确认与本地演示互动。`letter.css` 将固定纸张纹理、磨损边缘和羽毛装饰与内容分开。

读信时保留并暗化同一 MQ 场景，隐藏导航和普通账号入口，暂停背景响应；正文、配图、点赞和「留言」在同一信纸内部连续滚动。关闭按钮、Esc 和外围暗区共用关闭逻辑；有演示留言输入时先确认，继续编辑保留内容，关闭后恢复场景与触发入口焦点。展开/关闭期间拒绝冲突操作，减少动态效果模式取消舒展动画。

点赞只演示本次阅读的本地状态；「预览留言（不发送）」保留草稿并显示原型预览，不发送、公开或持久化评论。确认关闭后丢弃这些临时状态。分享 URL 在本轮接入：从首页打开可后退/前进，外部直达时关闭仅回 MQ 首页，不跳回外部网站。未提交草稿在站内关闭/历史导航时复用原确认框；跨文档离开和刷新使用浏览器原生 beforeunload，限制见 [分享说明](docs/engineering/STORY_SHARING.md)。真实点赞与留言服务仍未实现。

当前视觉精修使用产品负责人提供的《MQ 羽毛信视觉精修交接包 v1.0》中的独立透明旧纸、羽毛、蝴蝶邮戳及少量细分隔，来源与用途见 [素材说明](public/letter/README.md)。标题、元信息、图片混排及同纸留言区均为真实 DOM。中文采用宋体/楷体回退；桌面信纸宽上限 640px、高度上限 928px 且不超过视口 90%，展开 1000ms、关闭 400ms、背景暗化 60%。移动端缩小装饰并保留正文宽度。最新精修版已通过产品视觉验收，本轮保留这些参数；辅助目录的最终位置与外观仍待后续评审。纸纹不随文章长度增长，未使用整张目标参考截图作为网页背景。

Issue #3 的四项读信依赖已随 Issue #4 完成联合验收和收尾，P2-01 数据解耦亦已验收。后续改动仍须按实际影响验证，不能把历史通过结论当作新提交的测试结果；工程检查与产品验收分别记录。真实业务与剩余课程验收保留后续阶段。
