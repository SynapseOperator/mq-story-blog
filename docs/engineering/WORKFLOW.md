# MQ 工程工作流

本文件记录 Codex 开发系统 V1 的项目接入，不替代 PRD、设计裁决或执行日志，不声明尚未取得的 CI、保护或产品验收结果。

## 本阶段与 V1 接入

Phase 0 仅初始化 Next.js、TypeScript、Tailwind CSS、ESLint、资料与 GitHub 协作。Node 24.19.0、npm 11.17.0，锁文件为 `package-lock.json`。保持单仓库模块化单体；不加入数据库、真实账号、后台、私密故事或部署。

README 的 `npm run check` 串行运行 lint、typecheck、build。必要检查失败即停，不用空测试或吞掉退出码制造通过。浏览器行为、权限和持久化各有验证范围，构建不能替代；业务测试随真实行为增加。

`next.config.ts` 设置 `agentRules: false`：本次实测发现 Next.js 开发服务会自动向项目 AGENTS 追加框架模板，因此用框架公开配置保留已审阅的精简规则。框架 API 变化仍需查阅安装版本的 `node_modules/next/dist/docs/`。这不修改 Codex 全局配置或系统保护。

依赖安装时发现 ESLint 9.39.5 已结束支持，`eslint-config-next@16.4.2` 的传递 `braces <=3.0.3` 命中未修补的 high 通告 `GHSA-vfj7-8cjw-p6xm`，其 react/import/jsx-a11y 相关 peer 又不支持 ESLint 10。故采用已核验 peer 兼容的最小组合：ESLint 10.13.0、`@eslint/js` 10.0.1、`typescript-eslint` 8.72.0、`eslint-plugin-react-hooks` 7.1.1；移除 `eslint-config-next`，TypeScript 保持 5.9.3。相比保留旧组合，该方案避开已识别的传递依赖问题；代价是暂缺 Next 专用与 JSX 可访问性 lint 规则。后续组件需用浏览器验证和代码审查补充，待生态兼容后恢复这些规则，不把当前 lint 描述为完整的 Next/可访问性检查。

本机工具包：`D:\Bread_coding\CodexDevSystem\V1`。接入依据为 `SYSTEM.json`、`templates/PROJECT-ONBOARDING.txt`、`templates/node/quality-contract.txt` 及缓存来源清单。全局规则位于 `C:\Users\33684\.codex\AGENTS.md`；核对时 `D:\` 与 `D:\Bread_coding\` 无额外 AGENTS/override。项目规则只补 MQ 约束；保留既有 Codex/MCP/登录/安全配置，不新增重复 `.codex/config.toml`。

## Skills 来源与本地复现

| Skill | 官方来源与固定 commit | 已知许可 |
|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design)，`dbd4588f9e1033efb41dad4bef2f7947c8993d44` | 实际 Apache-2.0 LICENSE.txt |
| `frontend-testing-debugging` | [openai/plugins](https://github.com/openai/plugins/tree/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/build-web-apps/skills/frontend-testing-debugging)，`0722921d5542fc593105c27bd52630babd8b8c2a` | V1 审阅范围未发现明确许可，不编造授权 |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices)，`063bee94c3f4df8453406c830b0a7df0f2860278` | SKILL.md 声明 MIT，无独立许可文件 |

三个完整目录本地接入 `.agents/skills/`，由 Git 忽略，不随仓库分发。接入前对照 V1 的 `evidence/skill-snapshots.json` 核验缓存：2、2、76 个文件，共 80 个 SHA256 无差异。这只证明缓存完整性，不证明自动加载或调用。

先核对缓存 `sources.json` 与以上来源。在本项目根执行以下 PowerShell 代码可复现复制；已有目标会停止，先检查本地改动，不覆盖：

```powershell
$skillCache = 'D:\Bread_coding\CodexDevSystem\V1\skill-cache'
$skillTarget = Join-Path (Get-Location).Path '.agents\skills'
$skillNames = @('frontend-design', 'frontend-testing-debugging', 'vercel-react-best-practices')
foreach ($skillName in $skillNames) {
    $source = Join-Path $skillCache $skillName
    $target = Join-Path $skillTarget $skillName
    if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
        throw "Missing trusted cache: $skillName"
    }
    if (Test-Path -LiteralPath $target) {
        throw "Existing skill requires review: $skillName"
    }
}
New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
foreach ($skillName in $skillNames) {
    Copy-Item -LiteralPath (Join-Path $skillCache $skillName) -Destination $skillTarget -Recurse
}
```

其他开发者没有可信缓存时，按 V1 固定来源审阅流程接入，不从不明地址安装。保留 Vercel 的 `rules/`、内嵌 AGENTS、README、metadata 和所有实际许可；Skill AGENTS 不移到业务根。不使用符号链接，不全局安装，不自动升级快照。

进入项目的新 Codex 会话后核对三个名字是否可发现。实际使用时读取对应 SKILL.md，说明范围；显式名称为 `$frontend-design`、`$frontend-testing-debugging`、`$vercel-react-best-practices`。未验证新会话发现时，只报告本地接入，不能写已自动加载。

2026-10-21 已补做实际发现核验：新建短时本地 `codex app-server` 进程，通过 `initialize → initialized → skills/list`，指定本项目 cwd 且 `forceReload: true`。三个 Skills 均返回 `.agents/skills/<name>/SKILL.md`、`enabled: true`、`scope: repo`，发现错误与缺失均为 0；验证脚本和服务进程退出码均为 0。该检查没有创建持久线程、调用模型或更改全局配置，也不意味着本聊天自动加载或调用了全部 Skills。

设计以 PRD 为准。Browser 能力缺失时可回退项目 Playwright，并记录原因；不得虚构调用。上游 pnpm/Bash/`/tmp` 示例适配为 npm/PowerShell/系统临时目录，示例库与上游维护脚本不是本项目的安装依赖。

## 需求来源与编号

正式资料保存在 `docs/product/` 和本目录，保留导入内容与图片路径。原始 ZIP、手绘、教师原文及额外 Word 不进入提交清单。PRD 附图允许作为当前私有仓库的概念参考，不据此推断适合公开分发或直接作为产品素材。

PRD v1.1 的 UX-01～15 与验收清单 v1.0 的 UX-01～24 存在编号复用。Issue/PR 写来源、编号和行为，例如：

- 星尘不可点、故事星可点：`PRD v1.1 §12.1 UX-05` + `验收清单 v1.0 A2 UX-06/07`。
- 读信隐藏导航与普通登录：`PRD v1.1 §12.1 UX-09` + `验收清单 v1.0 A3 UX-11/12`。

不只引用裸编号，不修改原文掩盖差异。下一条建议任务为分层 MQ 静态场景。目录位置、信纸精确尺寸/动效、手机星位数量和部署平台留待评审；演示故事/状态须标明模拟，不能当作真实认证、数据库或审核功能。

## GitHub 与权限路径

[仓库](https://github.com/SynapseOperator/mq-story-blog) 所属账号 `SynapseOperator`。插件缺少创建仓库能力，因此创建一步使用已认证 `gh repo create`；之后通过 gh 只读核验 private 和 ADMIN。其他支持的操作继续优先插件。

初始检查中，插件读新仓库返回 404；用户随后完成授权，2026-10-21 通过 GitHub 插件重新读取成功，确认同一 owner、private 及 admin/push 权限。插件与 gh 的授权是不同通道。Projects 查询仍显示 gh 缺少 `read:project` scope，当前插件也未提供 Projects/Iteration 接口；创建还需写入能力。轻量看板和首轮 Iteration 保留待办，不把 Issues 冒充已建 Project。

四条真实 Issues 已通过 GitHub 插件创建并读回核验：

| 工作项 | 标签与负责范围 |
|---|---|
| [#1 初始化与 CI](https://github.com/SynapseOperator/mq-story-blog/issues/1) | documentation；SynapseOperator；工程基座和真实证据 |
| [#2 分层 MQ 场景](https://github.com/SynapseOperator/mq-story-blog/issues/2) | enhancement；待认领；静态分层、固定 UI、M/Q 建设中 |
| [#3 星空与篝火交互](https://github.com/SynapseOperator/mq-story-blog/issues/3) | enhancement；待认领；星光层次、视差、悬停和故事入口 |
| [#4 羽毛信阅读器](https://github.com/SynapseOperator/mq-story-blog/issues/4) | enhancement；待认领；阅读状态、关闭保护、移动目录 |

每条工作项包含 P0 优先级、负责范围、带来源的验收编号和阶段边界。#2 先完成场景；#3 提供故事入口/演示数据接口后 #4 可以开始，无需等 #3 关闭；#4 集成后再完成 #3 的读信验收。创建工作项不代表已授权或完成 Phase 1 编码。

CI 应覆盖 PR 与 main 的 push，只读 `contents` 权限，checkout 不持久化凭据，使用已审阅的固定官方 Action commit，不注入自定义密钥。交付附真实 Actions 链接；工作流文件存在不等于 CI 通过。

首次提交 `9e56fc6d2896253fdd0b3b9e157daf754aa96669` 已推送，[首次 Quality run](https://github.com/SynapseOperator/mq-story-blog/actions/runs/39593917608) 为 completed/success，安装、lint、typecheck 和生产构建全部通过。后续提交的状态以各自 run 为准。

本轮读取分支保护和 rulesets 均返回 HTTP 403，实际限制为当前套餐不支持该 private 仓库，保护未强制启用；没有升级套餐或改为 public。继续以小 PR、互审和 CI 作为协作约定，但不能将约定称为强制门禁。两位开发者各自使用个人 GitHub 账号，不猜测/邀请未知账号；后续共享应用管理员属于博客权限模型，不能替代个人开发贡献记录，不提前生成管理员密码。

## 课程证据与停止点

### 2026-10-21 本地初始化验证

| 实际命令/检查 | 结果 |
|---|---|
| `npm ci` | exit 0；174 packages installed，0 vulnerabilities |
| `npm run lint` | exit 0；ESLint 10，零警告门槛 |
| `npm run typecheck` | exit 0；Next 路由类型生成后 `tsc --noEmit` |
| `npm run build` / 最终 `npm run check` | exit 0；静态生成 `/`、`/_not-found`、`/icon.svg` |
| `npm audit --audit-level=high` | exit 0；0 vulnerabilities（检查时点结果） |
| `npm run dev -- --hostname 127.0.0.1 --port 3100` | Ready；两视口 HTTP 200 |
| `npm start -- --hostname 127.0.0.1 --port 3101` | Ready；两视口 HTTP 200 |
| 临时 Playwright smoke | dev/prod 均 exit 0；1440×900 与 390×844；标题、中文、占位内容、CSS、刷新、无横向溢出、无控制台错误通过 |
| 正式资料 / 忽略规则 | 10 个导入文件 SHA256 与原包一致；图片相对路径有效；`git check-ignore -v` 验证本地材料/环境/Skills/构建产物被排除 |

Browser plugin not available：本轮未列出旧 Browser 技能，按测试 Skill 回退至 V1 已验证的 Playwright 1.64.1 和 Chromium revision 1248；临时脚本与截图在系统临时目录，未成为项目依赖或提交内容。目标流程仅为首页加载 → 工程占位显示 → 刷新保持可读；页面无业务控件，不据此宣称任何 UX/FN 通过。两个服务验证后均用 Ctrl+C 停止，Windows 会话结束码 1 是主动中断，不是启动失败。

初始化中曾遇到默认 ESLint 9 停止支持及传递漏洞告警；切换依赖时旧锁解析出现 ERESOLVE，使用临时空目录重新解析锁文件再 `npm ci`，未用 force/legacy-peer-deps。首次浏览器 smoke 发现 favicon 404，补充中性工程图标后 dev/prod 重跑通过。原始失败没有伪装成一次通过。

沿用 [11 项评分映射](COURSE_DEVOPS_RUBRIC.md)：规划、工作项、迭代、开发提交、代码检查、构建、持续集成、主机配置、部署配置、分支合并、持续交付。记录真实发生的 Issue、commit、PR、审查与运行，未做项留待对应阶段，不补造历史。

老师允许的是 GitHub 工具链替换；托管平台是否满足主机配置验收尚待确认。Phase 0 后立即停止，不自动启动产品实现、采购或部署。
