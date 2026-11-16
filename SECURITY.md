# 安全问题报告

MQ Story 是个人维护项目。安全修复以最新受维护的 `main` 为目标；历史课程阶段、实验候选和旧镜像不承诺持续支持。构建、测试或已有 Review 通过，不表示不存在剩余风险；已知部署限制见[生产安全审查](docs/engineering/PRODUCTION_SECURITY_REVIEW.md)。

## 私密报告入口

**已选定 GitHub Private Vulnerability Reporting。** 该功能将在仓库获准正式公开后启用并验证；当前仍为 Private，不能将渠道选择视为入口已经可用。本项目不新增个人邮箱作为安全报告渠道。

当仓库 Security → Advisories 中显示 **Report a vulnerability** 时，请通过该入口提交私密报告。如果尚未显示，不要把敏感漏洞细节放到公开 Issue、PR 或评论中。维护者将在正式公开后按 GitHub 的[配置说明](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)启用功能，并验证报告入口可用。

报告尽量包含：

- 受影响的提交或版本、组件和利用所需权限；
- 使用合成数据的最小复现和预期/实际结果；
- 可能影响及可行的临时缓解方式；
- 一个可以继续私密联系的方式。

不要发送真实密码、AccessKey、Session Cookie、私钥、完整数据库或私人故事。如果意外泄露了自己的凭据，应通过对应服务立即撤销或轮换；不要为了证明漏洞继续访问他人数据。

## 测试边界与修复协作

可以在自己控制的本地隔离环境中验证。线上演示地址不构成授权渗透测试或拒绝服务测试的邀请；不得扫描或修改其他人的账号、备份和媒体。生产操作必须由维护者按明确目标批准。

维护者确认问题后会协调复现、修复、受影响范围与披露时机。项目没有承诺固定响应时限或漏洞奖金；不要将自动收件或代码合并视为已经部署修复。修复说明应区分真实验证、未验证部分和仍然存在的风险。
