# 文档索引

MQ Story 于 **2026-11-12** 正式上线，仓库于 **2026-11-16** 公开。项目支持七个故事星位、篝火故事、账号、后台编辑与发布、图片、点赞和留言审核。想先看实际效果，可以从[项目 README](../README.md)开始；准备在本地运行时，请阅读[开发指南](DEVELOPMENT.md)。

工程文档保留了从原型到上线的真实记录。下表的“合同”用于理解当前代码；文内带日期、阶段编号、测试数量、提交或扫描结果的段落是对应时点的证据，不是永久有效的生产状态。源码和具体目标的实时状态优先，历史的“尚未上线”不代表现站仍未上线。

## 开发与业务合同

| 主题 | 文档 |
|---|---|
| 新开发者入口 | [本地运行、配置与测试](DEVELOPMENT.md) · [项目协作约定](../AGENTS.md) |
| 数据库 | [开发/测试隔离与迁移](engineering/DATABASE.md) · [故事生命周期与原生约束](engineering/STORY_LIFECYCLE.md) |
| 身份与权限 | [用户名认证](engineering/AUTHENTICATION.md) · [受保护 Session 存储](engineering/SESSION_STORAGE.md) · [唯一管理员与事务权限](engineering/ADMIN_AUTHORIZATION.md) |
| 编辑与发布 | [草稿 API](engineering/ADMIN_DRAFTS.md) · [编辑器状态](engineering/ADMIN_EDITOR.md) · [私有预览](engineering/ADMIN_PREVIEW.md) · [星位与发布](engineering/STORY_PUBLICATION.md) |
| 公开阅读与互动 | [公开读取](engineering/PUBLIC_STORIES.md) · [分享与浏览历史](engineering/STORY_SHARING.md) · [点赞](engineering/STORY_LIKES.md) · [留言与审核](engineering/STORY_COMMENTS.md) |
| 图片 | [私有存储基础](engineering/MEDIA_FOUNDATION.md) · [上传](engineering/MEDIA_UPLOAD.md) · [故事关联](engineering/MEDIA_STORY_INTEGRATION.md) · [生命周期](engineering/MEDIA_LIFECYCLE.md) · [媒体备份](engineering/MEDIA_BACKUP.md) |

## 部署与运维合同

这些工具会操作明确的目标主机或存储。阅读文档、构建镜像和测试通过不授权修改现有生产环境。自建实例应使用自己的身份、秘密、域名及备份仓库。

| 主题 | 文档 |
|---|---|
| 容器与数据库身份 | [生产配置、五类身份及 11 个函数 owner](engineering/PRODUCTION_FOUNDATION.md) |
| 发布与回退 | [候选构建及 OCI 校验](engineering/RELEASE_OPERATIONS.md) · [bootstrap / upgrade / private-preview / activate](engineering/PRODUCTION_LAUNCH.md) |
| 主机 | [Ubuntu 准备](engineering/HOST_PREPARATION.md) · [运行与故障手册](engineering/OPERATIONS_RUNBOOK.md) |
| 账号和秘密 | [离线管理员维护](engineering/PRODUCTION_ADMIN.md) · [秘密轮换与恢复](engineering/SECRET_ROTATION.md) |
| 备份与告警 | [数据库与媒体一致性备份/恢复](engineering/PRODUCTION_BACKUP.md) · [OSS 和告警](engineering/OFFSITE_BACKUP_AND_ALERTS.md) · [固定来源的 Restic 构建](engineering/RESTIC_BUILD.md) |

## 产品与视觉依据

- [PRD v1.1](product/MQ_共享主页_PRD_v1.1.md)与[交互原型验收清单](product/MQ_交互原型验收清单_v1.0.md)：原始需求与验收编号；后续裁决见下一节。
- [视觉交接](product/visual-baseline-v1.0/VISUAL_HANDOFF.md)与[交接目录说明](product/visual-baseline-v1.0/README.md)：概念图和最初构图依据，**不是实际运行截图**。
- [场景素材说明](../public/scene/README.md)：资源路径和使用方式；素材随项目分发，独立复用范围见[版权说明](../ASSETS_LICENSE.md)。
- [历史交接 Prompt](product/visual-baseline-v1.0/CODEX_NEXT_STEP_PROMPT.md)：当时的工作说明，不能自动扩展当前任务授权。

## 决策与历史实施记录

保留记录是为了说明取舍和失败修复，不能将其计数、旧版本或未完成事项直接当作当前结果。

| 范围 | 记录 |
|---|---|
| 项目建立与需求裁决 | [工作流与 Phase 0 接入](engineering/WORKFLOW.md) · [需求裁决](engineering/DECISIONS_AND_REVIEW.md) · [交付阶段](engineering/DELIVERY_PHASES.md) |
| 课程与视觉验收 | [课程 11 项指标及真实证据](engineering/COURSE_DEVOPS_RUBRIC.md) · [Issue #2 视觉返工与验收](engineering/ISSUE_2_REVIEW.md) |
| P3 部署研究 | [部署就绪审查](engineering/DEPLOYMENT_READINESS.md) |
| P4 / P5 主机与隔离部署 | [VPS 容量快照](engineering/VPS_READINESS.md) · [当时部署缺口](engineering/VPS_DEPLOYMENT_GAPS.md) · [外部服务准备](engineering/VPS_EXTERNAL_SERVICES.md) · [首次 VPS 合成部署](engineering/VPS_ISOLATED_DEPLOYMENT.md) |
| 安全实验与扫描 | [Session 原值/简单摘要反例](engineering/SESSION_TOKEN_SPIKE.md) · [认证日志审查](engineering/AUTH_LOGGING_REVIEW.md) · [分阶段生产安全审查](engineering/PRODUCTION_SECURITY_REVIEW.md) · [P5-03 镜像扫描原始 JSON](engineering/security/P503_IMAGE_SCAN.json) |

当前 Session 实现以 [SESSION_STORAGE.md](engineering/SESSION_STORAGE.md) 为准，原值和简单摘要 Spike 是负控实验。历史镜像扫描只对应报告内的镜像与时间，既不能代表当前所有漏洞，也不能作为新版本的风险接受。

`WORKFLOW.md` 中的个人工具路径和 Skills 缓存仅是初始化记录；新 clone 不依赖这些目录。本仓库不分发生产秘密、数据库备份、浏览器会话、作者电脑上的证据目录或原始课程文件。

## 开源许可与协作

- [公开核验、授权与完成记录](engineering/OPEN_SOURCE_READINESS.md)
- [MIT 代码许可](../LICENSE) · [素材版权与分发边界](../ASSETS_LICENSE.md)
- [贡献指南](../CONTRIBUTING.md) · [安全问题报告](../SECURITY.md)
- [真实展示截图及来源](showcase/README.md)
