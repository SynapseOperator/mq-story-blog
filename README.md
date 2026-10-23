# MQ · Our Stories

MQ 是以共同回忆为主题的个人博客，也是《软件工程—敏捷 DevOps 方法》的课程项目。老师允许以 GitHub 替换华为工具链，个人博客题目与课程工程证据要求仍然有效。

当前为 **Phase 2 · P2-02：PostgreSQL 开发与测试基础**（[Issue #10](https://github.com/SynapseOperator/mq-story-blog/issues/10)）。Phase 1 的静态场景、环境交互和羽毛信阅读器已通过产品验收；PR #5 / #6 / #7 已合并，Issue #1–#4 已关闭。P2-01 的数据契约与稳定星位解耦已通过产品验收，[PR #9](https://github.com/SynapseOperator/mq-story-blog/pull/9) 已合并，[Issue #8](https://github.com/SynapseOperator/mq-story-blog/issues/8) 已关闭；[合并后的 main CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/39933860000) 成功，合并提交为 `6dcd0d3990b5b48ebdc909148b6c7516515fe04f`。

本任务只建设数据库基础设施、迁移与集成测试，保留四份合成演示故事及已验收的构图、动画和阅读行为。完成后提交 Draft PR，等待产品与开发者评审，不自动合并或开始 P2-03。数据库探针不是博客业务模型；网站仍使用演示数据，真实故事、认证、点赞/留言服务与部署尚未实现。

Phase 2 架构审查已确认继续使用 Next.js 模块化单体，采用 PostgreSQL 18 + Prisma 7 稳定线；后续业务采用独立草稿与公开版本、显式发布更新和受限结构化内容块。认证框架在 P2-04 经最小技术验证后确定，优先评估成熟方案。沿用已审查的 P2-01 至 P2-14 Roadmap，后续实现细节按对应任务确认。

仓库：[SynapseOperator/mq-story-blog](https://github.com/SynapseOperator/mq-story-blog)，创建时已核实为 private。未来如需公开，须重新审查文档、图片、许可与隐私。

## 运行与检查

环境：Node.js **24.19.0**、npm **11.17.0**。使用 npm 与 `package-lock.json`，不混用锁文件。在仓库根执行：

```sh
npm ci
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。Windows PowerShell 如受脚本执行策略限制，使用 `npm.cmd` 执行相同命令，不修改系统策略。

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

数据库环境、独立开发/测试入口、迁移与验证命令见 [数据库开发与测试说明](docs/engineering/DATABASE.md)。`npm run check` 可在没有数据库时检查现有前端；真实 PostgreSQL 迁移、隔离及持久化由独立数据库检查验证，不能用前端构建成功代替。2026-10-23 已按负责人授权安装官方 Docker Desktop（per-user / WSL 2），Windows 本机的迁移、11 项集成测试及 5 项隔离/持久化检查通过；与 Linux CI 的结果、版本差异和启动问题边界分别记录在该说明中。

## 工程与需求入口

- Next.js **16.4.2** App Router、React、TypeScript **5.9.3**、Tailwind CSS 4、ESLint **10.13.0**，由 `create-next-app@16.4.2 --empty` 起步。ESLint 的最小适配与规则缺口见 [工作流](docs/engineering/WORKFLOW.md)。
- `src/app/`：应用路由、MQ 场景首页与 M/Q 建设中页面。保持单仓库模块化单体，按实际需要增加模块。
- `src/components/scene/`：独立场景图层、固定导航与建设中视图；七张本地美术素材及来源、处理与差异说明见 [public/scene](public/scene/README.md)。
- `src/components/reader/`：复用的羽毛信阅读器及样式；纸张与羽毛为独立装饰，文字、图片与控件由 DOM 渲染，素材说明见 [public/letter](public/letter/README.md)。
- `src/lib/stories/`：独立阅读契约与稳定场景绑定；`src/data/` 提供当前合成演示数据，由首页路由适配后传给组件。后续真实数据在此页面边界接入，不让组件依赖演示数据源；本轮数据库基础尚不接入场景或阅读器。
- `prisma/`：基础探针 Schema 与版本化迁移；[数据库说明](docs/engineering/DATABASE.md) 记录开发/测试隔离、凭据管理和实际验证边界。
- `docs/product/`：正式 PRD、原型验收与关联图片，保持图片相对路径有效。
- `docs/engineering/`：设计裁决、阶段划分、课程评分映射与工作流。

先读 [PRD v1.1](docs/product/MQ_共享主页_PRD_v1.1.md)、[设计裁决](docs/engineering/DECISIONS_AND_REVIEW.md)、[原型验收清单](docs/product/MQ_交互原型验收清单_v1.0.md)。文字要求优先于概念图。PRD 与清单的 UX 编号不是同一映射，Issue/PR 必须带来源分别引用。

2026-10-21 正式确认的 [视觉交接](docs/product/visual-baseline-v1.0/VISUAL_HANDOFF.md) 替代早期概念图的美术方向：[A 首页](docs/product/visual-baseline-v1.0/assets/A_MQ_home_approved.png) 是唯一场景构图/色彩基准；[B 羽毛信](docs/product/visual-baseline-v1.0/assets/B_MQ_letter_open_approved.png) 是已验收阅读器的视觉依据。两张都是合成参考图，不是页面可直接使用的独立图层；不得将图中 UI 当成真实控件。B 的导航/账号显示痕迹不覆盖 PRD 的阅读隐藏规则，阅读背景必须继续使用 A。

原型可使用清楚标注的演示内容；可点击 UI、静态数据与本地状态不能证明真实认证、权限、持久化、审核和发布已完成。`LOCAL_ONLY_REFERENCE/` 中原始手绘、课程原文及额外 Word 文件不进入 Git，不上传 GitHub。

## 开发协作

两位开发者分别使用自己的 GitHub 账号，以 Issue 明确范围和验收，在功能分支提交小 PR，互审后合并。未来应用内唯一共享管理员与 GitHub 开发账号是两个权限边界；本阶段不创建管理员账号或密码，不邀请未经确认的协作者。

PR #9 因第二位开发者暂时无法 Review，按产品负责人明确授权采用一次性 Review Exception，见 [审计说明](https://github.com/SynapseOperator/mq-story-blog/pull/9#issuecomment-6362057412)。这不是正式独立 Review 已通过；独立复核保留为非阻塞事项，其他 PR 继续按各自授权和评审门槛处理。

任务开始先读 [AGENTS.md](AGENTS.md) 并核对 `git status`；Skills 接入与权限路径见 [工作流](docs/engineering/WORKFLOW.md)。按 [课程 11 项评分映射](docs/engineering/COURSE_DEVOPS_RUBRIC.md) 积累真实证据，不补造历史。

本分支 `chore/p2-02-postgresql-foundation` 对应 [#10 数据库开发与测试基础](https://github.com/SynapseOperator/mq-story-blog/issues/10)。四条初始化/原型工作项及依赖的历史记录见 [工作流](docs/engineering/WORKFLOW.md)；其中 Phase 0 的命令与范围是历史快照，当前命令以本 README 和 `package.json` 为准。目录最终位置、移动端高清素材、候选星位数量与部署平台仍待后续决定；本轮保留已验收的视觉参数，不将原型参数扩展为永久产品约束。

已完成的静态场景检查、浏览器覆盖、初版返工过程与最终签收见 [Issue #2 验收记录](docs/engineering/ISSUE_2_REVIEW.md)；其中签收前的“待审”文字属于历史快照。

## 场景与阅读器原型操作

首页三颗故事星支持鼠标悬停标题、键盘焦点与单次触屏点按；篝火悬停/键盘聚焦增强火焰和暖光，木柴不随之缩放。不同故事星打开各自的合成演示文章，篝火固定打开《我们在一起的故事》，所有入口复用同一个羽毛信组件。移动端辅助回忆目录可展开、收起，并打开同一阅读层；其位置和外观是试验方案。

故事星用常驻的暖金四角星芒及薄光环区别于底图星点，最暗闪烁阶段仍保持可见；悬停/聚焦进一步增强。高密度竖屏选择原图的无损 WebP 编码，减少草地与银河纹理的压缩损失；未改变构图或生成新美术。原图分辨率、景深与首次加载体积的边界见 [素材说明](public/scene/README.md)。

- `src/data/demo-stories.ts`：保留四个稳定 ID 和 `synthetic-demo` 来源标记，包含合成标题、虚构日期、正文与配图；《把日常写成诗》用于长文阅读检查，不含真实回忆或照片。`demo-bindings.ts` 单独按故事 ID 指定稳定星位及篝火身份，不依赖数组下标。
- `src/lib/stories/story.ts`：独立的只读 `Story` 阅读契约；`scene-catalog.ts` 将显式绑定与可用故事适配为场景数据，并将逻辑 slot 映射到已有 CSS 位置。重排或过滤故事不会重新分配其他故事的位置；缺失的故事不生成入口。这里的绑定校验不代替后续数据库级约束。
- `landscape.tsx`：背景/前景位移包装层、同层故事星与触区、独立火焰/暖光、局部草叶遮罩；按传入的稳定 slot 渲染现有位置。三颗演示星及其响应式位置不代表最终数量或星位策略。
- `use-scene-motion.ts`：单个指针订阅与按需 rAF 平滑位移；触屏禁用视差，系统减少动态效果时关闭循环运动和视差，入口仍可操作。
- `scene-page.tsx`：固定 Logo/导航/账号占位、阅读器入口状态及辅助目录。M/Q 保持建设中，不提供故事控件或循环动画。
- `src/components/reader/feather-letter.tsx`：原生模态阅读层、内部滚动、草稿关闭确认与本地演示互动。`letter.css` 将固定纸张纹理、磨损边缘和羽毛装饰与内容分开。

读信时保留并暗化同一 MQ 场景，隐藏导航和普通账号入口，暂停背景响应；正文、配图、点赞和「留言」在同一信纸内部连续滚动。关闭按钮、Esc 和外围暗区共用关闭逻辑；有演示留言输入时先确认，继续编辑保留内容，关闭后恢复场景与触发入口焦点。展开/关闭期间拒绝冲突操作，减少动态效果模式取消舒展动画。

点赞只演示本次阅读的本地状态；「预览留言（不发送）」保留草稿并显示原型预览，不发送、公开或持久化评论，也不声称真实提交成功。关闭阅读器会丢弃这些临时状态。本轮不实现认证、真实点赞/留言服务、真实分享 URL 或公开权限控制。

当前视觉精修使用产品负责人提供的《MQ 羽毛信视觉精修交接包 v1.0》中的独立透明旧纸、羽毛、蝴蝶邮戳及少量细分隔，来源与用途见 [素材说明](public/letter/README.md)。标题、元信息、图片混排及同纸留言区均为真实 DOM。中文采用宋体/楷体回退；桌面信纸宽上限 640px、高度上限 928px 且不超过视口 90%，展开 1000ms、关闭 400ms、背景暗化 60%。移动端缩小装饰并保留正文宽度。最新精修版已通过产品视觉验收，本轮保留这些参数；辅助目录的最终位置与外观仍待后续评审。纸纹不随文章长度增长，未使用整张目标参考截图作为网页背景。

Issue #3 的四项读信依赖已随 Issue #4 完成联合验收和收尾，P2-01 数据解耦亦已验收。后续改动仍须按实际影响验证，不能把历史通过结论当作新提交的测试结果；工程检查与产品验收分别记录。真实业务与剩余课程验收保留后续阶段。
