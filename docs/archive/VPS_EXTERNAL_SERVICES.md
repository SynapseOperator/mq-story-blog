# 域名、异地备份与告警准备

本文保留 P4-02 的历史公开查询。后续实名已通过，P5-01 已核验 A 指向 VPS；下表 clientHold/NXDOMAIN 不是当前状态。P5-02 当前 R2、费用、飞书适配和外部探针以 [异地备份与告警](../engineering/OFFSITE_BACKUP_AND_ALERTS.md) 为准。本文不授权改 DNS、购买服务、生成正式凭据或发送通知。现有工具合同见 [PRODUCTION_BACKUP.md](../engineering/PRODUCTION_BACKUP.md)、[RELEASE_OPERATIONS.md](../engineering/RELEASE_OPERATIONS.md) 和 [OPERATIONS_RUNBOOK.md](../engineering/OPERATIONS_RUNBOOK.md)。

## 域名实查

查询时间：**2026-11-07 03:40:33–03:40:50 UTC**。通过 [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json) 定位 `.xyz` 官方服务，再请求 [mq-story.xyz Registry RDAP](https://rdap.centralnic.com/xyz/domain/mq-story.xyz)。仅输出下列字段，没有记录注册人联系资料。

| 项目 | 实际结果 |
| --- | --- |
| 注册时间 | 2026-11-06 14:44:04 UTC |
| RDAP 最近变更 | 2026-11-06 15:14:43 UTC |
| 到期时间 | 2027-11-06 23:59:59 UTC |
| 状态 | **client hold**；server transfer prohibited、client renew prohibited、client transfer prohibited、add period |
| 注册记录中的 NS | dns19.hichina.com、dns20.hichina.com |
| Registry DNSSEC 字段 | delegationSigned=false |
| Google 与 Cloudflare 递归 DNS | NS、A、AAAA、CAA、DS 均返回 **Status=3 / NXDOMAIN**，无 Answer，AD=false |

DNS 分别通过 [Google DoH](https://dns.google/resolve?name=mq-story.xyz&type=A) 和 [Cloudflare DoH](https://cloudflare-dns.com/dns-query?name=mq-story.xyz&type=A) 查询，Cloudflare 使用 `Accept: application/dns-json`。以上命令退出 0；NXDOMAIN 是被成功读取的 DNS 结果，不是网站已经可用。

`clientHold` 表示注册商要求域名不激活 DNS；注册记录中的 NS 不证明已经公开委派。当前公开解析是上线阻塞项，但 **RDAP/DNS 不能证明实名认证通过或失败**。需要负责人在注册商后台核实 hold 原因、实名进度及解除条件。CAA 等记录暂时不可公开核实，不能将 NXDOMAIN 写成“已确认没有 CAA 限制”。[ICANN 状态说明](https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en)

解除 hold 后，按以下顺序验收，实施仍需单独授权：

1. 复查 RDAP、权威委派及至少两家递归 DNS。确认 A 指向目标 VPS；只有实际 IPv6 地址、路由和双栈防火墙均验收后才增加 AAAA。保留现有 DNS 服务商即可，不为部署额外迁移 NS。
2. 核对 CAA 与实际启用的证书颁发机构兼容；确认域名、应用 Origin 和 Caddy 主机名一致，不引入通配 Origin。
3. 授权开放入口后，仅 Caddy 发布 80/443，3000/5432 保持私网。先使用 ACME 测试端点检查签发路径，再进行正式证书验收；持久化 Caddy 数据目录。
4. 从主机外验证 HTTP 跳转、证书主机名/信任链/到期时间、HTTPS Cookie 与应用健康。检查续期错误和临期告警；Caddy 进程运行不等于证书签发成功。当前没有申请证书、开放端口或完成这些公网验收。[Caddy 自动 HTTPS 要求](https://caddyserver.com/docs/automatic-https)

## 两个月异地备份选择

以下费用于 **2026-11-07 UTC** 查询官网，币种为美元，不含税及可能的计费取整；免费额度不是硬性费用上限。当前没有创建账号、桶或云密钥。

| 方案 | 当前官方价格与本项目取舍 |
| --- | --- |
| Cloudflare R2 Standard | 每月含 10 GB-month、100 万 Class A 和 1000 万 Class B 请求；额外存储 $0.015/GB-month，直接出站免费。当前备份每次读取整个仓库校验，出站不收费较合适。首版不选有读取费和最低保留期的 Infrequent Access。[官方价格](https://developers.cloudflare.com/r2/pricing/) |
| Backblaze B2 | 起价 $6.95/TB/月，前 10GB 存储免费；免费月出站为平均存储量的 3 倍，通常超出后 $0.01/GB。小仓库存储便宜，但每日全仓检查可能超过免费出站量，不能只按存储价格估算。[官方价格](https://www.backblaze.com/cloud-storage/pricing) |
| 负责人已有独立 S3 服务 | 可避免新增付费账户；先核实 HTTPS、IAM、容量、请求/出站费和实际恢复。已有代码兼容 S3 协议不证明兼容每家供应商的策略；同一 VPS 上的目录不算异地副本。 |

建议先由负责人确认是否已有可用存储；没有时优先评估 R2 Standard。使用私有专用桶/前缀，不启用公共 URL，限制到备份所需对象与锁管理权限，不交给应用运行身份。R2 的 `auto` region 与当前配置合同兼容，但真实端点仍待实测。[R2 S3 接入](https://developers.cloudflare.com/r2/get-started/s3/)

容量以首个实际仓库为基准，不能按照片文件大小简单累加：保留版本还包含数据库 dump 和历史媒体。示例若两个月平均各占 20GB，且请求仍在免费额度内，R2 额外存储约为 `(20−10)×0.015×2 = $0.30`；这是预算算例，不是实际账单或两个月零费用承诺。VPS 费用预算不能自动视作云存储采购授权。

## 备份窗口、空间与保留

- 沿用 Restic 加密、固定仓库 ID 与 Git 外文件秘密。密码应另行离线保存；备份含账号、可能有效的原值 Session Token 和业务签名密钥，不能公开或上传 CI Artifacts。
- 每日一次、重大部署前额外一次；**RPO 24 小时、RTO 4 小时仍是目标**，尚未在真实 VPS 与供应商上验证。RTO 需包含下载、恢复、重新配置权限/秘密和 HTTPS 应用验收。
- 当前工具先关闭入口并停写；停写覆盖远端传输、`restic check --read-data` 全仓读取和恢复校验。不能把合成环境数秒结果当作真实停机时长。供应商选择后先用合成数据实测完整窗口、吞吐、费用和恢复。[Restic 仓库检查](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)
- 现有空间准入保留三倍数据库估算大小与媒体字节数，加 256MiB 余量；同时保留原有低磁盘拒写线。还要为现存数据、OCI 产物、镜像与日志留空间。远端 S3 配额不能通过本地 `statfs` 验证，需供应商用量告警。40GB 主机不长期留同盘全量副本。
- 保留计划固定 **7 daily / 8 weekly**，目前只执行 `forget --dry-run`，不删除、不 prune。按 host/tag 分组；保留天数不是严格快照份数上限，不能据此承诺仓库永远低于免费额度。真实删除策略须另行批准。[Restic 保留语义](https://restic.readthedocs.io/en/stable/060_forget.html)
- `ops/mq-backup@.timer` 是 **尚未安装/启用** 的模板：主机时区 03:30、最多 5 分钟随机延迟、`Persistent=false`。负责人需先确认时区和可接受停机窗口，再完成首次手工备份/隔离恢复后安装。失败保留停止入口/停写状态和诊断锁，需要人工核实，不能反复启动或自动解锁掩盖故障。

## 告警与待确认事项

现有告警工具默认 dry-run，真实渠道和接收人尚未配置。建议仅向负责人专用运维群或既有个人通知渠道发送固定错误码和脱敏摘要；不得向协作者发送 Review 请求、提及或催审提醒。

可以选择已有飞书自定义机器人或现有受控 webhook。飞书要求自己的 `msg_type/content` 消息格式，并提供签名、IP 等保护设置；项目通用 JSON 信封不能直接宣称可投递。选择渠道后再做小适配及模拟测试，获授权后验证真实送达、失败重试、重复抑制和恢复通知。Webhook 作为秘密文件保管，不写入仓库或聊天。[飞书官方接入](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)

每日备份与健康检查调度均待实机安装验收。主机断电时同机探针无法发送故障通知，因此上线验收还需一个主机外的可用性检查来源；不据此默认采购 SaaS。证书、数据库、磁盘及备份过期告警以现有阈值为准，不通过降低阈值制造通过。

负责人需确认三件事：域名 hold 的处理结果及 DNS 授权；备份服务/预算/停机时区与后续保留删除授权；仅负责人接收的告警渠道和外部检查来源。**已验证的是公共 RDAP/DNS 与当前代码合同；真实云备份、通知送达、公网 HTTPS 和定时任务仍未执行。**
