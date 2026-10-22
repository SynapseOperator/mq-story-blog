# MQ · Our Stories

MQ 是以共同回忆为主题的个人博客，也是《软件工程—敏捷 DevOps 方法》的课程项目。老师允许以 GitHub 替换华为工具链，个人博客题目与课程工程证据要求仍然有效。

当前为 **Phase 1 · Issue #4：羽毛信阅读器开发**。Issue #2 的静态场景与 Issue #3 的环境交互已通过产品视觉验收；[PR #5](https://github.com/SynapseOperator/mq-story-blog/pull/5) 和 [PR #6](https://github.com/SynapseOperator/mq-story-blog/pull/6) 已合并。PR #6 合并提交为 `1eebac27a78e15350c53c9e2bec8de5feeeb5e9f`，[合并后 main CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/39745231516) 成功；Issue #2 的过程见 [验收记录](docs/engineering/ISSUE_2_REVIEW.md)。

本任务复用已验收的构图、场景素材与故事入口，新增可复用的羽毛信阅读层和合成演示文章。Issue #3 保持打开，等待与阅读器联合验收。Issue #4 的工程检查、浏览器证据及视觉差异以本任务交付和 Draft PR 的实际记录为准，不沿用前一阶段的通过结论；完成后等待产品与独立开发者评审，不自动合并。真实故事业务、认证、数据库和部署尚未实现。

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
npm run build
npm start
```

`npm start` 需先成功构建；它与开发服务使用相同默认端口，不要同时启动。用 Ctrl+C 停止自己启动的服务。一次执行全部工程检查：

```sh
npm run check
```

`check` 串行执行 lint、类型检查和生产构建，任一步失败即返回非零。此处为操作说明，实际结果以命令退出码及对应 [Actions 记录](https://github.com/SynapseOperator/mq-story-blog/actions) 为准。没有空的 `test` 命令；真实业务测试随相应行为实现。

## 工程与需求入口

- Next.js **16.4.2** App Router、React、TypeScript **5.9.3**、Tailwind CSS 4、ESLint **10.13.0**，由 `create-next-app@16.4.2 --empty` 起步。ESLint 的最小适配与规则缺口见 [工作流](docs/engineering/WORKFLOW.md)。
- `src/app/`：应用路由、MQ 场景首页与 M/Q 建设中页面。保持单仓库模块化单体，按实际需要增加模块。
- `src/components/scene/`：独立场景图层、固定导航与建设中视图；七张本地美术素材及来源、处理与差异说明见 [public/scene](public/scene/README.md)。
- `src/components/reader/`：复用的羽毛信阅读器及样式；纸张与羽毛为独立装饰，文字、图片与控件由 DOM 渲染，素材说明见 [public/letter](public/letter/README.md)。
- `docs/product/`：正式 PRD、原型验收与关联图片，保持图片相对路径有效。
- `docs/engineering/`：设计裁决、阶段划分、课程评分映射与工作流。

先读 [PRD v1.1](docs/product/MQ_共享主页_PRD_v1.1.md)、[设计裁决](docs/engineering/DECISIONS_AND_REVIEW.md)、[原型验收清单](docs/product/MQ_交互原型验收清单_v1.0.md)。文字要求优先于概念图。PRD 与清单的 UX 编号不是同一映射，Issue/PR 必须带来源分别引用。

2026-10-21 正式确认的 [视觉交接](docs/product/visual-baseline-v1.0/VISUAL_HANDOFF.md) 替代早期概念图的美术方向：[A 首页](docs/product/visual-baseline-v1.0/assets/A_MQ_home_approved.png) 是唯一场景构图/色彩基准；[B 羽毛信](docs/product/visual-baseline-v1.0/assets/B_MQ_letter_open_approved.png) 是本轮阅读器的视觉依据。两张都是合成参考图，不是页面可直接使用的独立图层；不得将图中 UI 当成真实控件。B 的导航/账号显示痕迹不覆盖 PRD 的阅读隐藏规则，阅读背景必须继续使用 A。

原型可使用清楚标注的演示内容；可点击 UI、静态数据与本地状态不能证明真实认证、权限、持久化、审核和发布已完成。`LOCAL_ONLY_REFERENCE/` 中原始手绘、课程原文及额外 Word 文件不进入 Git，不上传 GitHub。

## 开发协作

两位开发者分别使用自己的 GitHub 账号，以 Issue 明确范围和验收，在功能分支提交小 PR，互审后合并。未来应用内唯一共享管理员与 GitHub 开发账号是两个权限边界；本阶段不创建管理员账号或密码，不邀请未经确认的协作者。

任务开始先读 [AGENTS.md](AGENTS.md) 并核对 `git status`；Skills 接入与权限路径见 [工作流](docs/engineering/WORKFLOW.md)。按 [课程 11 项评分映射](docs/engineering/COURSE_DEVOPS_RUBRIC.md) 积累真实证据，不补造历史。

本分支 `feat/issue-4-feather-letter-reader` 对应 [#4 羽毛信阅读器](https://github.com/SynapseOperator/mq-story-blog/issues/4)，并联合验证 [#3 星星与篝火交互](https://github.com/SynapseOperator/mq-story-blog/issues/3) 的读信依赖。四条初始化/原型工作项及依赖见 [工作流](docs/engineering/WORKFLOW.md)。目录位置、信纸精确尺寸/动效、手机星位数量与部署平台仍待后续决定，不在本原型中冻结。

已完成的静态场景检查、浏览器覆盖、初版返工过程与最终签收见 [Issue #2 验收记录](docs/engineering/ISSUE_2_REVIEW.md)；其中签收前的“待审”文字属于历史快照。

## 场景与阅读器原型操作

首页三颗故事星支持鼠标悬停标题、键盘焦点与单次触屏点按；篝火悬停/键盘聚焦增强火焰和暖光，木柴不随之缩放。不同故事星打开各自的合成演示文章，篝火固定打开《我们在一起的故事》，所有入口复用同一个羽毛信组件。移动端辅助回忆目录可展开、收起，并打开同一阅读层；其位置和外观是试验方案。

故事星用常驻的暖金四角星芒及薄光环区别于底图星点，最暗闪烁阶段仍保持可见；悬停/聚焦进一步增强。高密度竖屏选择原图的无损 WebP 编码，减少草地与银河纹理的压缩损失；未改变构图或生成新美术。原图分辨率、景深与首次加载体积的边界见 [素材说明](public/scene/README.md)。

- `src/components/scene/demo-stories.ts`：保留四个稳定 ID 和 `synthetic-demo` 来源标记，包含合成标题、虚构日期、正文与配图；《把日常写成诗》用于长文阅读检查，不含真实回忆或照片。
- `landscape.tsx`：背景/前景位移包装层、同层故事星与触区、独立火焰/暖光、局部草叶遮罩。三颗演示星及其响应式位置不代表最终数量或星位策略。
- `use-scene-motion.ts`：单个指针订阅与按需 rAF 平滑位移；触屏禁用视差，系统减少动态效果时关闭循环运动和视差，入口仍可操作。
- `scene-page.tsx`：固定 Logo/导航/账号占位、阅读器入口状态及辅助目录。M/Q 保持建设中，不提供故事控件或循环动画。
- `src/components/reader/feather-letter.tsx`：原生模态阅读层、内部滚动、草稿关闭确认与本地演示互动。`letter.css` 将固定纸张纹理、磨损边缘和羽毛装饰与内容分开。

读信时保留并暗化同一 MQ 场景，隐藏导航和普通账号入口，暂停背景响应；正文、配图、点赞和「留言」在同一信纸内部连续滚动。关闭按钮、Esc 和外围暗区共用关闭逻辑；有演示留言输入时先确认，继续编辑保留内容，关闭后恢复场景与触发入口焦点。展开/关闭期间拒绝冲突操作，减少动态效果模式取消舒展动画。

点赞只演示本次阅读的本地状态；「预览留言（不发送）」保留草稿并显示原型预览，不发送、公开或持久化评论，也不声称真实提交成功。关闭阅读器会丢弃这些临时状态。本轮不实现认证、真实点赞/留言服务、真实分享 URL 或公开权限控制。

当前视觉试验采用暖米黄旧纸、深棕墨色、独立羽毛和中文宋体/楷体回退；桌面信纸宽上限 680px、高度上限 900px 且不超过视口 86%，展开 1000ms、关闭 400ms、背景暗化 60%。移动端另有视口适配。这些数值、字体、目录样式和重制素材均待产品视觉验收，不是最终设计要求。纸纹不随文章长度增长，未将 B 的文字效果图或邮戳直接用作可操作界面。

Issue #3 的四项读信依赖需结合本轮真实浏览器测试与人工评审共同核对；当前开发分支不自动关闭 Issue #3 / #4。工程检查通过不代表阅读器视觉与交互验收通过，未完成的真实业务与课程验收仍保留后续阶段。
