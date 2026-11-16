# P6：开源核验与公开记录

首次核验日期：2026-11-13。基线：`8dcf7cc8130cc0e2ad7390e48f80bd663032721b`。公开日期：2026-11-16。本文保留当时的源码与 GitHub 历史检查结果，并记录后续授权和公开操作；本次状态同步没有重跑历史审查或生产测试。

**结论 A 已执行：原仓库已公开，未改写历史，也未另建公开版本。** 首次核验结论为 B；负责人随后确认了双方 MIT 授权、素材有限分发及历史记录公开范围，并授权合并和公开。[PR #74](https://github.com/SynapseOperator/mq-story-blog/pull/74) 在最新 HEAD 获得独立 APPROVED 后，以普通 merge 合入 main，合并提交为 `914ef9d6c3c0d2e14ad7df4d692e8d8f42e91c0c`，Issue #73 已关闭。

当前仓库为 **Public**，GitHub Private Vulnerability Reporting 已启用。匿名 API 已验证公开状态及 `enabled: true`，公开 Advisories 页面已显示 **Report a vulnerability** 入口；未提交测试漏洞报告。公开操作没有改动生产服务、删除记录或发送审核提醒。

## 首次核验范围（2026-11-13，保留原证据）

| 对象 | 实际覆盖 | 结果及边界 |
| --- | --- | --- |
| 当前文件与 Git 历史 | 基线 441 个跟踪文件；75 个已取得的本地/远端引用；128 个可达提交、1,123 个 blob | 扫描 1,224 个文本对象，12,264,231 字节；不读取忽略的本机秘密文件 |
| 二进制图片历史 | 27 个 PNG/WebP blob，含 6 个旧素材版本 | 均能解析，无 EXIF/GPS；这是元数据检查，不是逐图内容审查或版权证明 |
| Issues / PR | 完整分页取得 73 条 Issue/PR、92 条讨论评论、57 条 Review、0 条逐行 Review 评论 | 扫描标题、正文及评论；没有发现所检查格式的私有附件链接 |
| Actions | 完整枚举 124 次运行，全部取得日志响应；528 个日志文本文件，共 40,290,453 字节 | 120 次有日志，4 次没有任务日志；包含失败与取消记录，没有仅选成功运行 |
| Actions artifacts | 当前 API 完整分页库存为 0 | 没有可下载工件可检查；不代表已过期或已删除工件已审查 |
| 安全报告入口 | 私密漏洞报告 API 只读查询返回 HTTP 404，命令退出 1 | 状态未验证，不能据此断言已启用或已禁用 |

检查使用 Git 对象读取及 GitHub 只读 API；日志在内存中检查，证据仅保存路径、对象/运行 ID、分类、计数和不可逆指纹，不保存凭据匹配原值。外部任务证据为 `git-audit.json`、`github-audit.json`、`image-metadata-audit.json`；未将原始 GitHub 日志或本机秘密归档提交到仓库。

Git 和首批 GitHub 审查脚本退出 **0**，剩余 96 次 Actions 日志审查退出 **0**，图片元数据检查退出 **0**。这些是公开适用性检查结果，不是业务测试或生产安全放行。

## 发现及最小处理

### 1. 凭据：未确认真实泄露

检查覆盖私钥 PEM 标记、常见 GitHub/AWS/阿里云 Token 格式、飞书/Slack 秘密、带凭据的连接 URL、签名云 URL 及长秘密字面量。Git 历史产生 48 条规则命中，经上下文复核均为合成测试值或运行时拼接模板；GitHub 文本及全部可取得的 Actions 日志没有凭据规则命中。

例如 [`scripts/db/init-env.mjs`](../../scripts/db/init-env.mjs) 中的数据库 URL 是生成配置的模板；相关测试里的密码、连接串是隔离测试 fixture。不能把这些命中数当作真实泄露数，也不能把零已确认泄露解释为全历史绝无秘密。

本轮没有读取生产秘密、VPS 数据库或私有媒体。配置模板与运维合同可以公开，但不得附带本机证据目录、数据库转储、Cookie、真实 `.env`、云凭据或恢复包。

### 2. 历史个人信息：负责人已接受公开范围

- Git 历史中有 3 个作者身份：93 个提交使用 GitHub noreply 地址，另外 35 个提交使用个人邮箱。报告不重复输出邮箱原值。负责人已明确接受现有作者邮箱及署名随原仓库历史公开。
- 基线当前文档及历史版本共发现 11 条作者本机路径引用。当前开发说明可改成仓库相对路径或证据集名称，但旧提交仍保留原路径和部分本机用户名。这些不是访问凭据。
- [PR #64](https://github.com/SynapseOperator/mq-story-blog/pull/64)、[PR #66](https://github.com/SynapseOperator/mq-story-blog/pull/66)、[PR #70](https://github.com/SynapseOperator/mq-story-blog/pull/70)、[PR #72](https://github.com/SynapseOperator/mq-story-blog/pull/72) 正文含本机证据路径。负责人已接受这些记录公开；保留历史，不再为这些已确认内容改写提交或修改旧 PR。
- [`docs/product/`](../product/) 保留情侣主题 PRD、产品设计图与课程工程记录。视觉交接说明把示例标题、昵称和评论标记为合成参考；负责人已接受现有产品记录公开。

没有发现所检查格式的 `user-attachments` / 私有 GitHub 图片链接；这不等于下载并审查了所有外链目标。普通外链、被删除的附件、图片中可读的个人信息，以及未被 API 返回的内容不在已验证范围。负责人如记得曾上传私人附件，应在公开前定点检查该附件；本轮不批量删除历史。

### 3. 许可与素材：已完成授权确认

负责人已确认双方共同作者同意 MIT，并选择使用 GitHub 账号名署名。[`LICENSE`](../../LICENSE) 已移除候选声明，版权行内容为 `Copyright (c) 2026 SynapseOperator and SnorkelingBreather`，采用完整 MIT 正式条款。

[`ASSETS_LICENSE.md`](../../ASSETS_LICENSE.md) 将程序代码与美术分开。负责人已允许现有个人美术随本 GitHub 仓库公开展示、下载及 Fork；这些素材、产品参考图和含素材的截图不纳入代码 MIT，其他项目的独立复用仍须取得相应权利人许可。来源记录及第三方原有许可继续保留。

本轮保留美术和历史，没有声称所有图像为纯手绘原创，也没有将第三方依赖、系统字体或真实用户内容纳入 MIT。新增首页截图来自实际公网首页，不含私人故事正文；阅读器截图来自隔离环境的合成内容，均保留[实际运行来源说明](../showcase/README.md)。

### 4. 对外协作：私密漏洞报告已启用

GitHub Private Vulnerability Reporting 已于 2026-11-16 启用并完成设置与入口验证。安全问题通过 [Security → Advisories](https://github.com/SynapseOperator/mq-story-blog/security/advisories) 的私密入口报告，具体说明见 [`SECURITY.md`](../../SECURITY.md)。不新增个人邮箱，也不使用公开 Issue 收集秘密或漏洞细节。

将仓库转为 Public 会使 Actions 历史和日志对外可见，因此不能只检查当前文件；这是本轮检查历史日志的原因。参阅 [GitHub 可见性说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。

## 公开方式的决定

| 选项 | 当前状态 | 结果 |
| --- | --- | --- |
| A．原仓库直接公开 | **已完成** | PR #74 普通合并，原仓库公开，私密漏洞报告已启用并验证 |
| B．指定处理后公开 | 原确认事项已完成 | 本次提交落实 MIT、素材、历史和报告渠道决定，不再重复索取同一授权 |
| C．保留私有，另建公开版本 | 当前不需要 | 没有本轮证据要求另建仓库，保留原工程历史 |

选择 C 不需要也不意味着删除原仓库。仅从最新分支移除文件不能消除历史中的内容；本轮没有改写历史，也没有创建另一个仓库。

## 首次交付验证（2026-11-13，未重复执行）

- `npm run check` 退出 **0**：lint、Schema、类型检查、生产构建通过；363 项测试中 357 项通过、6 项按既有平台/环境条件跳过，无失败。本轮未重跑数据库、浏览器和生产容器完整套件，业务代码与迁移未改动。
- 文档/模板检查退出 **0**：56 份 Markdown 的 215 个本地链接目标存在，两个 Issue YAML 可解析，README/开发指南所列 npm 脚本均存在；`git diff --check` 通过。
- 原有 `scripts/db/init-env.mjs` 与 `scripts/auth/init-env.mjs` 在项目外临时目录首次执行均退出 **0**；重复执行均退出 **1** 且原文件不变，随机秘密及本地目标检查通过。没有将其描述为全新 clone 的完整业务端到端验收。
- P6 改动文件的增量凭据扫描未命中规则；三张实际截图无 EXIF 元数据，场景及合成内容已目视核对。另一个 Agent 完成文档交叉复核并发现一处截图来源表述不一致，已修正；这不是 GitHub 协作者 APPROVED 或独立法务意见。
- 远端 CI 沿用负责人额度豁免，未运行不写成通过；未改变工作流、分支保护或 `package.json` 的 `private: true`。

## 许可收尾验证（2026-11-16）

当时仅修改 8 份许可和直接引用文档。定向检查退出 **0**：完整 MIT 条款保持不变，2026 年及双方公开账号署名准确，107 个本地链接目标有效；过时候选声明已移除，`git diff --check` 通过。检查器首次因 Windows 默认 GBK 解码退出 1，显式使用 UTF-8 后通过，未修改产品代码。没有重跑历史审查、完整测试或生产验收；远端 CI 额度豁免继续保留。此后最终提交 `ae91f483cacde34422d2b128ea2c08afbb068ae7` 获得匹配的独立 APPROVED，再按负责人授权完成合并和公开。

本结果只覆盖本次取得的可达引用与 API 库存，不覆盖服务器上不可达对象、已删除讨论、过期工件、未来提交或外部附件内容。之后若有新的敏感材料进入仓库，应针对变化复核，无需重做未变化的生产验收。
