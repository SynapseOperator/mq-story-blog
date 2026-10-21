# MQ 项目协作约定

## 范围与需求

- 默认中文沟通。开始前读 README、相关正式文档和 `git status`，保留他人未提交改动。
- 当前授权为 Phase 1 的 Issue #2：静态分层 MQ 场景、M/Q 建设中页面与账号入口视觉占位。完成本任务 PR 后停止，等待两位开发者视觉评审；不自动合并，不提前执行 Issue #3/#4 或增加认证、数据库、后台、部署。
- 最新用户确认、PRD v1.1 与 `docs/engineering/DECISIONS_AND_REVIEW.md` 是需求依据，其次为原型验收清单；文字优先于概念图，不凭图片改设计。
- 验收引用写来源、编号和行为，例如 `PRD v1.1 UX-05 + 验收清单 v1.0 UX-06/07`。不要假定同号对应，不为消除差异偷改正式资料。
- 后续设计保留中央上方 Logo、青草山坡/情侣/篝火、无萤火虫、故事星可点/星尘不可点、M/Q 建设中；读信时隐藏 MQ/M/Q 导航和普通登录入口。待确认布局与参数保持开放。

## 实现与验证

- 一个 Issue 对应一个可审查的小增量；跨模块先给验收与短计划，高影响权限/数据决定先说明取舍。不新增重复 PLAN/STATE/STATUS 文档。
- 使用 TypeScript、现有 App Router 约定与 npm 锁文件；模块随真实需要增加，不提前抽象或无关重构。
- 仓库根命令：`npm ci`、`npm run dev`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check`；构建后可 `npm start`。PowerShell 可用 `npm.cmd`。
- 行为变化补有价值的真实测试，报告命令、退出码和范围。不写空测试，不把 build 通过当作浏览器、权限或持久化验证。
- 视觉任务使用 `frontend-design`，UI 调试/浏览器验收使用 `frontend-testing-debugging`，实质 React 改动读取 `vercel-react-best-practices` 相关规则；PRD 约束优先。
- 三个 Skills 从 V1 可信缓存完整复制到 `.agents/skills/` 且被 Git 忽略。进入项目的新 Codex 会话后检查发现情况；文件存在、读取与自动加载是不同事实，不虚报本轮自动加载或实际调用。
- 测试 Skill 中 `frontend-app-builder` 对应本项目 `frontend-design`，`react-best-practices` 对应 `vercel-react-best-practices`，不重复安装别名技能。Browser 不可用时可在同一目标/数据/权限边界回退项目 Playwright，并记录原因。

## 数据与协作边界

- 不提交 `.env`、凭据、真实私密故事/照片、原始课程材料、`LOCAL_ONLY_REFERENCE/` 或浏览器会话。后续公开注册只能产生普通用户。
- 两位开发者用各自 GitHub 账号，小 PR 互审；不猜账号或擅自邀请。应用共享管理员不意味着共用 GitHub 身份。
- 远端写入遵守本次授权；未授权不改变可见性、不采购或部署。核对真实状态后才报告 Actions/分支保护结果。接入说明见 `docs/engineering/WORKFLOW.md`。
