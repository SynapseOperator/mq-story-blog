# P5-02：异地备份与负责人告警

**P5-04负责人决定：OSS选择A。** 保留每日备份、每日完整`check --read-data`、精确快照提取核验、仓库ID、新鲜度告警及保留dry-run。首周每天记录非秘密的仓库容量、上传/下载字节、请求次数、备份与校验耗时，对照OSS账单和免费额度；七日后由负责人决定是否另开调整，不自动降低频率。统计可来自OSS用量/费用控制台与脱敏Restic汇总，不为收集指标扩大当前RAM权限。本轮不修改真实RAM、删除快照、安装timer或发送告警。

2026-11-08 负责人决定：Cloudflare R2 因支付绑定失败不再作为目标，改用 **Alibaba Cloud OSS，中国香港，Standard + ZRS，私有 Bucket**。此前没有建立 R2 仓库，因此没有数据迁移。Restic 客户端加密、数据库/媒体一致性、固定仓库 ID、停写窗口和隔离恢复仍遵守 [备份合同](PRODUCTION_BACKUP.md)。负责人已创建 `mq-story-backups`，确认 Standard + ZRS、Private、版本控制关闭，专用 RAM 身份为 `mq-story-backup`。本轮先完成安全文件交接及真实合成备份/恢复；不上传个人数据，不安装正式定时任务。Bucket 属性目前为负责人控制台确认，不能以 Restic 成功访问代替整桶策略审计。告警继续只验证模拟接收。

## OSS 接入合同

使用项目锁定的 Restic 0.19.1 官方 Alibaba 示例组合：

- Repository：`s3:https://oss-cn-hongkong.aliyuncs.com/BUCKET/production`
- Restic region：`oss-cn-hongkong`；不是 R2 的 `auto`。
- Bucket lookup：固定 `dns`，实际请求由 Restic 使用 `BUCKET.oss-cn-hongkong.aliyuncs.com`。
- 标准 HTTPS/系统 CA；拒绝自定义 CA、非标准端口、内部/其他地域 Endpoint、重复 Bucket 子域名和带点 Bucket 名。

阿里云当前 AWS SDK 指南另有 `s3.oss-{region}.aliyuncs.com` 与 `cn-hongkong` 的组合。本工具不混配这两套配置，也不在签名失败时自动换 Endpoint/region。真实 OSS 签名与小对象读写已完成合成验收；更严格生产 RAM 策略和 multipart 故障清理仍待单独验证。[锁定 Restic 文档](https://github.com/restic/restic/blob/v0.19.1/doc/030_preparing_a_new_repo.rst#alibaba-cloud-aliyun-object-storage-system-oss)、[OSS virtual-hosted 要求](https://www.alibabacloud.com/help/en/oss/developer-reference/compatibility-with-amazon-s3)、[当前 AWS SDK 接入指南](https://www.alibabacloud.com/help/en/oss/developer-reference/use-aws-sdks-to-access-oss)

小鸡云 VPS 并非阿里云同地域 ECS，不能因为同在香港就使用 OSS internal Endpoint。保留公网 HTTPS 存储连接；这不需要开放网站端口，也不需要更改 `mq-story.xyz` 解析。[地域与 Endpoint](https://www.alibabacloud.com/help/en/oss/user-guide/regions-and-endpoints)

## 控制台配置与秘密交接

1. 在 OSS 控制台创建只用于 MQ 备份的 Bucket：地域 **中国香港**、存储类型 **标准存储 Standard**、冗余类型 **同城冗余 ZRS**、读写权限 **私有**，启用阻止公共访问。不要开启静态网站、传输加速、公共域名或自动删除对象的生命周期规则。版本控制/WORM 不擅自启用；它们影响锁文件、成本和后续清理，需单独评估。
2. 负责人已提供上述非秘密配置。AccessKey 只在本机隐藏输入窗口交接，保存至 Git 外、当前 Windows 用户与 SYSTEM 专属 ACL 的目录；不发送至聊天。Standard/ZRS/版本控制/完整 Bucket 策略仍需控制台或 OSS 原生 GetBucketInfo 实查，S3 URL 不能证明这些属性。
3. 现有专用 RAM 身份仅供程序访问，不给控制台登录、账号管理或 `AliyunOSSFullAccess`。使用 [RAM 策略模板](../../ops/oss-restic-ram-policy.example.json)，替换明确的账号 ID、Bucket 名；不得同时附加宽泛权限策略。
4. 凭据仅通过本机安全交互保存为 Git 外文件，格式为 `accessKeyId`、`secretAccessKey` 的 JSON；短期 STS 凭据可另有 `sessionToken`。Linux 文件 0400/0600、父目录 0700；不发到聊天、截图、Git、命令参数或 shell 历史。Restic 密码单独生成、离线保管，不能只与 OSS 凭据一起留在同一 VPS。
5. 使用 [非秘密环境模板](../../ops/oss-hongkong-backup.env.example) 和已有 [Compose 覆盖模板](../../ops/backup-compose.example.yaml)。所有占位值必须替换；CLI 仍拒绝自动 S3 init。负责人本次已批准在独立 `p502-synthetic/<随机UUID>` 前缀初始化并执行小于 1 GiB 的合成备份/恢复。该授权不覆盖 `production/`，后者仍须另行确认。初始化后固定核验出的仓库 ID；错误密码/目标不得触发自动创建或换路径重试。

推荐日常 RAM 身份仅在专用 `production/` 前缀读写和列举，删除权限只用于 Restic 锁文件；备份数据实际 `forget/prune` 需要另行批准的维护权限。其权限并非不可篡改备份：PutObject 仍可能覆盖对象，Restic 密码和访问凭据必须分开保管。真实云端必须验证另一个 Bucket、其他 prefix、数据删除、ACL 修改和 Bucket 管理均被拒绝，不能用模拟 IAM 冒充阿里 RAM 验收。[OSS 授权语法与动作](https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements)

当前负责人策略列出 ListObjects、GetBucketInfo、GetObject、PutObject、DeleteObject，仅限目标 Bucket。它足以开始本次小规模验收，但整桶 DeleteObject 如覆盖数据对象则比日常备份需要宽，正式运行前应收紧到仓库锁前缀。缺少 AbortMultipartUpload 是分片失败清理缺口，建议只对仓库前缀增加；本次固定 Restic 默认约16 MiB pack，小型文件不依赖该路径，不把“成功备份”当作已覆盖分片失败。

首次受控 `restic init` 先使用同一份最小 RAM 策略。Restic 0.19.1 会先做 HeadBucket，但明确容忍其返回 AccessDenied，不能因此预先放宽 Bucket 根目录列举权限。若真实 OSS 初始化失败，保留脱敏错误码和 request-id 诊断，不自动扩权、换路径或创建 Bucket。固定 region 后正常读写不需要 GetBucketLocation；如需 API 读取地域，另行评估该 Bucket 的只读诊断权限。[Restic 初始化实现](https://github.com/restic/restic/blob/v0.19.1/internal/backend/s3/s3.go)、[MinIO HEAD 错误映射](https://github.com/minio/minio-go/blob/v7.1.0/api-error-response.go)

## 保留、费用、恢复与轮换

- 每日备份，重大升级前额外备份；现有模板主机时区03:30，安装前确认维护窗口。RPO 24小时、RTO 4小时均待真实远端恢复测定。7 daily / 8 weekly 仍仅 `forget --dry-run`，不自动删除快照或 prune。
- 不沿用 R2 免费额度或免费出站估算。OSS 的存储、API 请求、恢复及 `check --read-data` 的公网下载都可能计费；香港 VPS 到 OSS 的下载不是免费内网流量。两个月预算按 `2 × 平均存储GB × 月单价 + 总出网GB × 单价 + 请求数费用` 核算，控制台实际地域/币种/优惠优先，不自动购买资源包。[存储计费](https://www.alibabacloud.com/help/en/oss/storage-fees)、[公网流量计费](https://www.alibabacloud.com/help/en/oss/traffic-fees)、[官方价格](https://www.alibabacloud.com/en/product/oss/pricing)
- 2026-11-08 核对中国站香港价格：Standard ZRS ¥0.156/GB/月，公网流出5GB–10TB档¥0.75/GB；Standard PUT类每月前500万、GET类前2000万次免费，超出均¥0.01/万次。香港每月5GB公网流出额度的当前剩余量未知，ZRS不适用LRS免费存储，预算先不抵扣。保守两个月公式为 `0.312 × 平均仓库GiB + 0.75 × 累计下载GiB + 超额请求费`；1GiB平均库存加2GiB下载约¥1.81，5GiB加10GiB约¥9.06，不是费用上限。[香港价格表](https://www.aliyun.com/price/detail/oss)、[免费额度规则](https://help.aliyun.com/zh/oss/free-quota-for-new-users)
- 当前完整校验会下载全部仓库内容。若仓库平均20GB，每天一次完整读取、60天约产生1200GB读取，另加备份校验提取、恢复演练和请求；这是仅全库检查部分的流量估算，不是账单。不能只按当前照片容量预算，也不为省费用静默减少校验。
- 备份前后检查非零退出、成功 receipt、仓库 ID 和26小时新鲜度；OSS 控制台监测容量、请求、出网及账单。没有通用S3剩余额度API，不能用VPS `statfs` 代替云配额。
- 真正异地验收：合成数据备份至实际私有OSS → 从云端恢复至不同的空数据库/媒体目录 → 对比dump/清单/文件SHA-256 → 验证旧Session失效、权限、HTTPS、公开与私有媒体。记录停写窗口、传输量和恢复时长。P5-02 已实际完成该合成演练，数据见文末；正式目标仍需重新验收。
- RAM AccessKey 轮换：同一受限身份新key → 安全文件 → 同仓库ID核验/合成恢复 → 原子切换 → 撤销旧key并验证拒绝。Restic解密密码轮换是另一流程，需验证历史恢复；不能自动删旧key。泄露后的旧副本无法被换密码追回。

## 告警通道与探针

`operations-check.mjs` 仍检查主机内存/负载、8 GiB 磁盘余量、inode、容器健康/OOM/端口与备份新鲜度，现在还验证公开 `/api/stories` 的 HTTPS 200 JSON 响应；仅证书握手成功不再算网站健康。错误响应、重定向、超时、超大/非法 JSON 均产生固定 `HTTPS_UNAVAILABLE`，不输出正文。

```sh
# 主机内：需要受控的 Docker 只读诊断权限及原有 MQ_OPS_* 非秘密配置。
node scripts/production/monitor-runner.mjs

# 主机外：仅需 MQ_OPS_DEPLOYMENT_ID 与 MQ_OPS_ORIGIN，不需要 Docker 或数据库凭据。
node scripts/production/monitor-runner.mjs --external
```

两个命令默认只输出脱敏检测和告警预览，故障仍退出 1。主机外探针必须实际位于另一台持续运行的设备/服务；同一 VPS 的进程无法在整机断电或网络隔离时通知负责人。当前未选择外部探针位置，不能声称外部可用性监控已上线。

新增 `ops/mq-monitor@.service` / `.timer` 为每五分钟只读模板，使用本机已核验的 `/opt/mq/node-v24.19.0/bin/node`，没有 `--send`。备份模板也改为该实际 Node 路径。复制模板不等于安装、启用或通知授权；服务器没有新增 timer。

## 飞书适配与送达验收

本轮新增显式 `MQ_ALERT_CHANNEL=feishu`，沿用 `MQ_ALERT_WEBHOOK_URL_FILE`，另外通过 `MQ_ALERT_SIGNING_SECRET_FILE` 读取签名秘密。只接受飞书官方机器人路径，发送固定文本和脱敏故障码，无 @、正文、URL、Cookie 或私密日志。签名按官方 HMAC 合同计算；只有 HTTP 2xx 且 JSON `code=0` 才记为 delivered，不能把 HTTP 200 的关键词/IP/签名拒绝当成功。[飞书机器人官方指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)

默认 generic 通道保持兼容。连接故障、429/5xx 最多尝试两次，复用事件 ID；重定向不跟随，飞书业务拒绝不盲目重试，响应正文有界且不写日志。飞书不提供本工具可依赖的幂等消费保证，响应丢失时接收端可能已收到，重试可能造成两条消息；不能承诺 exactly-once。跨定时周期不自动去重，正式启用前由负责人确认可接受的故障重复频率或再增加独立的简单抑制策略。

未来真实验收需要负责人本人建立专用运维群/机器人，开启签名校验（可加关键词 `MQ 运维告警` 和实测出站 IP 白名单），安全保存 webhook 与签名文件，并明确允许一条测试通知。随后执行实际探针故障通知，负责人确认收到、固定事件 ID 和恢复后的健康检查；非零退出必须另有可见记录。不能把模拟接收端 code=0 当作飞书本人已收到。

P5-03 负责人已确认飞书机器人配置完成；Webhook及签名已通过本机隐藏输入安全交接，存于项目外且ACL仅允许当前Windows用户与SYSTEM，未传至VPS。随后负责人单独批准一条真实送达测试：2026-11-08T12:37:35.893Z，接口返回成功、attempts=1，负责人也确认群里收到“MQ 运维告警 · 送达测试（非故障）”。没有附带日志、个人资料或@提及，没有启用自动发送。没有配置真实邮箱；邮箱方案需负责人已有的受控 SMTP/邮件 API，不能擅自以个人 Gmail 发通知或新建账号。

## P5-03：生产备份与告警收口

本轮没有连接真实 OSS、修改 RAM、删除快照、传送生产凭据或启用 timer。保留既有合成仓库；正式仓库只使用 `mq-story-backups/production`，另行初始化、另存 Restic 密码并记录新 repository ID。代码现在拒绝跨 production/staging 前缀写入，监控也必须匹配 S3 backend 和 repository ID，不能用同部署的本地备份回执代替异地成功。

### RAM 调整建议与验收

负责人批准后，把日常身份收敛为现有模板的范围：Bucket 级 `ListObjects` 仅列 `production/*`；对象级 `GetObject`、`PutObject`、`AbortMultipartUpload` 仅限该前缀；`DeleteObject` 仅限 `production/locks/*`。恢复使用读权限和锁权限，保留预览不需要删除数据；真正 forget/prune 另用获批的临时维护权限。不要给 Bucket、ACL、账号管理权限，也不增加 FullAccess。

当前真实身份仍有较宽的目标 Bucket DeleteObject；这里是建议，未替负责人修改。正式收紧后在另行批准的合成前缀重复备份、列举、check、恢复、锁释放；再用专门的合成探针验证数据删除与其他前缀被拒绝。不要以真实快照做删除负控。现有 OSS 协议 fixture 已证明 Restic 正常路径不依赖非锁 Delete，但不能证明阿里 RAM 真实执行结果。

Restic 0.19.1 S3 实现使用200MiB分片阈值，本项目约16MiB pack 的实际小规模演练没有触发它。传输中断时已知 uploadId 的中止仅需对象前缀内 `oss:AbortMultipartUpload`；它不删除已经完成的对象，仍在上传的分片可能要再次核对。进程完全丢失 uploadId 后，枚举残留任务另需 Bucket 级 `oss:ListMultipartUploads`，逐项检查可需 `oss:ListParts`。不默认授予日常身份这些维护权限，也不假定 ListObjects 的 `oss:Prefix` 条件同样约束 ListMultipartUploads；负责人可在控制台列出残留任务，再批准精确 key/uploadId 的清理。禁止无目标的全桶 abort 或生命周期自动删除。[Restic 锁定实现](https://github.com/restic/restic/blob/v0.19.1/internal/backend/s3/s3.go)、[AbortMultipartUpload](https://www.alibabacloud.com/help/en/oss/developer-reference/abortmultipartupload)、[ListParts](https://www.alibabacloud.com/help/en/oss/developer-reference/listparts)、[权限元素](https://help.aliyun.com/zh/oss/user-guide/authorization-syntax-and-elements)

锁限定 Delete 仍不是不可篡改备份：被盗的 PutObject 凭据可覆盖已知对象；Restic 会发现认证/完整性错误，但不能恢复已被覆盖的唯一副本。ZRS 解决机房故障，不解决凭据被盗。建议另保留一份由负责人离线持有的加密副本和独立 Restic 密码；不可把 AccessKey、密码和唯一备份全部留在 VPS。版本控制或对象锁涉及保留/费用及锁语义，应另行评估，不在本轮擅自开启。

### 日程与两个月费用

保持当前强校验：每日03:30备份，上传后全仓 `check --read-data`，再提取精确 snapshot 并验证清单/图片，最后才写成功回执。每日任务仍会在整个传输与校验期间停写；必须实测正式数据量的维护窗口。每五分钟检查服务及26小时备份新鲜度；每周人工看容量、费用和7日/8周保留 dry-run；正式开放前、每月及重要恢复变更后执行隔离恢复。所有这些是待批准的运行安排，不是已经启用的任务。

2026-11-08 官方香港价格仍为 Standard ZRS ¥0.156/GB/月，公网下载5GB–10TB档¥0.75/GB。免费额度按账号剩余量结算，预算不预扣；ZRS不享受LRS免费存储。本项目香港VPS不是阿里云同地域ECS，下载不能按免费内网计价。[价格表](https://www.aliyun.com/price/detail/oss)、[流量规则](https://help.aliyun.com/zh/oss/traffic-fees)、[免费额度适用范围](https://help.aliyun.com/zh/oss/free-quota-for-new-users)

令 R 为平均加密仓库GB，S为一次完整snapshot读取GB。60次日备份的下载预算至少按 `60×(R+S)` 估算，另加元数据、重试和恢复演练；两个月费用约 `0.312R + 0.75×总下载GB + 超额请求费`。以下仅为不同数据规模的假设，不是实测未来增长或费用上限：

| R / S（均取相同大小） | 两个月日常校验下载估算 | 存储+下载估算，未抵免费额度 |
| --- | --- | --- |
| 0.1GB | 12GB | ¥9.03 |
| 1GB | 120GB | ¥90.31 |
| 5GB | 600GB | ¥451.56 |

不要把前文“存1GB、只下载2GB”的示例当成每日强校验账单。备份的去重会节省上传和库存，但 `--no-cache`、全仓校验和全snapshot恢复仍消耗下载。每日看账户账单，首周按真实增长修订预算；达到负责人预算时告警并讨论调整，不自动停掉备份或降低验证。

若费用不合适，可另行批准实现“每日结构check+当前snapshot验证、每周全仓check”的不同回执合同；它仍要每天读取当前snapshot。更大数据量才考虑确定性的 `--read-data-subset=n/t` 周期，并记录每组成功时间；随机百分比不能保证覆盖全仓。**当前代码仍要求全仓读取，没有实现或启用这些降频选项。** [Restic 校验与下载成本](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)

### 飞书最小交接

1. 负责人建立只通知本人的运维群，添加自定义机器人，开启签名校验；可加关键词 `MQ 运维告警`。若用出站IP白名单，分别核对VPS和外部探针，不能凭域名推断。
2. Webhook和签名通过本机安全文件交接，Linux父目录0700、文件0400/0600；不粘贴聊天，不放环境值、Git或命令参数。现有模板只保存文件路径。
3. 负责人明确授权“一条送达测试”后，才对新生成的 `ALERT_DELIVERY_TEST` 报告调用既有发送入口。标题明确标为“送达测试（非故障）”，只尝试一次HTTP请求，响应丢失或503不自动重试；先由负责人核对是否已收到，再决定后续操作。核对程序的 `delivered=true`、事件ID、时间及实际收件，程序返回成功不能代替人工确认。本轮真实测试已按该流程通过，事件 `3cd739a9-c199-441b-8379-4224abe0bfbc`；本地HTTPS测试另覆盖拒绝、超时及不重复发送。该授权仅用于这一条消息。
4. 确认送达后另行批准运行频率。普通故障告警单次调用最多尝试两次，重试使用相同事件ID；飞书响应丢失仍可能重复收到。没有跨周期抑制状态，直接给现有5分钟timer加 `--send` 会持续重复通知；建议主机每5分钟只读检查，发送按负责人选定的15或30分钟周期安排，不能称为已实现告警去重。

外部可用性探针应放在负责人另一台持续在线的主机或后续获批的低成本服务，只需正式origin、部署ID和该通道的秘密，不给数据库/OSS凭据。它验证HTTPS、证书期限和真实公开查询；VPS内部探针负责磁盘、内存、数据库/容器和备份。当前只验证本机到飞书群的真实送达；外部运行位置、VPS定时任务及真实故障链尚未配置，不能覆盖整台VPS失联时的自动通知。

## 原 P5-02 验证记录（2026-11-07）

- Windows `node --test tests/production-alert-webhook.test.mjs tests/production-external-alerts.test.mjs tests/production-operations.test.mjs tests/production-backup.test.mjs`：35 项通过，退出 0；包含真实本地 HTTPS、飞书签名/ACK、503、证书拒绝、重定向、超时、响应尺寸、CLI 默认不发送及 R2 合同。
- Linux：在现有 tools 镜像中，以非 root、只读文件系统、`--network none` 和临时目录执行同一组 35 项测试，全部通过、无跳过、退出 0；只挂载本轮脚本与测试，没有挂载秘密或 Docker socket。
- 定向 ESLint：首次因新增测试缺少 URL import 退出 1；补充显式 import 后退出 0，测试条件未变。
- 原R2没有开通；新的真实OSS仓库、RAM权限/配额、远端恢复、实际飞书送达、主机外探针和systemd安装：**尚未执行，依赖负责人操作与授权**。
- 现有 S3/Restic 数据库与媒体联合演练由完整 Container CI 继续覆盖；其最终结果以本 PR 的最新提交为准。

## OSS 适配与真实演练入口（2026-11-08）

`npm run test:backup:oss` 使用 Docker internal 网络、Caddy 测试 CA 和固定 Moto 镜像，运行真实 Restic 0.19.1。96 次本地请求验证虚拟主机、签名 region、init 的 HeadBucket 403 兼容、加密备份、全量检查及恢复；错误密码和仓库 ID 拒绝。此用例进入 Container CI，不需要云账号，不证明实际 RAM 策略。

实际云端使用独立 opt-in 入口，路径参数不是秘密值：

```powershell
$env:MQ_LAB_OSS_CONFIRM='synthetic-cloud-under-1gib'
$env:MQ_LAB_OSS_CREDENTIALS_FILE='<Git 外、已核验 ACL 的真实文件路径>'
$env:MQ_LAB_OSS_PASSWORD_FILE='<独立保存的本次合成仓库密码文件路径>'
node scripts/production/lab.mjs --oss
```

Windows 需使用经过 `realpath` 核验的实际路径；Codex/MSIX 可能将 LocalAppData 重定向至应用 LocalCache。不要关闭已有真实路径/ACL 检查解决重定向。源文件不进入工作区；凭据经 stdin 装入本次 UID10001/0400 秘密卷，成功或失败均检查专属标签后清理这份临时副本。Restic 的短生命周期子进程仍使用 SDK 要求的 AWS 环境变量，不能声称主机 root 或同身份进程无法读取。

该模式复用原数据库、HTTP、媒体及 HTTPS 浏览器恢复链，固定 `mq-story-backups/p502-synthetic/<随机UUID>`，初始化前必须列举为空并确认 config 404。数据库和媒体保守预算限制为128MiB，低于负责人1GiB上限；云端另统计对象总量与最大对象。只保留策略预览，不删除云端快照/数据；Restic正常释放本次锁文件。源密码旁保留 attempt、repository 和 result JSON，记录仓库ID、snapshot、字节数和耗时。应用业务和VPS配置不随演练开放。

首次真实预检的预算为27,374,607 bytes（数据库10,589,887、媒体7,504及16MiB余量）。ListObjectsV2 返回 AccessDenied，流程在 init 和上传之前停止，退出1；已定点清理临时凭据卷，保留合成诊断数据。需要核对 Bucket 级 ListObjects 的 Resource、测试前缀条件及 RAM 身份绑定；不得自动扩权。后续真实云端执行结果以 PR #60 的最新验收记录为准，不能用上述模拟测试代替。

负责人随后确认策略未绑定到 RAM 用户；完成绑定后，完全相同的 ListObjectsV2 和 config HEAD 预检通过，未修改或扩大权限。第二次演练发现 operations 镜像没有系统 CA 包：Node 内置根证书可用，但 Go/Restic 的 HTTPS 校验失败，测试前缀仍为空。现已在 tools/operations 安装发行版官方 `ca-certificates`，构建时检查证书包；OSS 协议测试也在注入本地测试 CA 之前验证镜像原生证书包。未关闭 TLS、改为 HTTP 或接受自签名云证书。

第三次真实演练 `node scripts/production/lab.mjs --oss` 退出0。使用本机 Docker 的随机合成数据库/媒体卷，备份到真实 OSS，再恢复到另一个空目标；未从 VPS 提取真实数据。原始失败和成功证据保留在开发机 Git 外。

| 实际结果 | 数值 / 验证 |
| --- | --- |
| 测试前缀 | `p502-synthetic/0e44e847-d771-4358-909c-7a15ea4e24d6` |
| 仓库 ID | `086abc4e54b8b02fe25d5959c59fd41c79d792eaf0f55dd7ab7c0c032b1e2a3a` |
| 快照 ID | `1f30ec6da9a2446d7f24a3a2d77c56d655b1277bcb6c45eea0741c9351bfd347` |
| 输入数据 | PostgreSQL dump 91,095 bytes；媒体7,504 bytes |
| 云端加密对象 | 6个，共26,682 bytes；最大对象22,924 bytes；匿名 config HEAD被拒 |
| 备份及全量校验 | 44.150秒 |
| 恢复数据库和媒体 | 27.431秒；至HTTPS/桌面手机渲染验收共43.692秒 |
| 恢复权限 | 约束、五类身份和11个函数owner核验；旧Session失效，业务签名清除；重新登录后管理员私有图片可读，游客私有GET/HEAD拒绝 |
| 失败与保留 | 错误密码/凭据/仓库ID拒绝；失败CLI退出1且无成功回执，产生BACKUP_MISSING_OR_STALE；7日/8周只做dry-run，未删除快照或数据 |

本次小对象真实路径通过现有权限，没有请求额外RAM权限。没有触发 multipart，因此未证明大对象中断清理；未来需要该路径时，应补充仅目标前缀的 `oss:AbortMultipartUpload`，不能授予FullAccess。当前Bucket范围DeleteObject比日常锁释放所需更宽，正式配置可按上方模板收窄；本轮未改用户策略，也未尝试访问其他Bucket来推断权限范围。

上述字节数是输入/云端对象大小，不是TLS重传或账户账单计量。按当前价格，本次小型演练预估不足¥0.01；实际免费额度、请求和出网账单以控制台为准。云端仓库和本机独立Restic密码均保留，临时容器凭据副本已清理。尚未把正式备份密钥放到VPS，也未安装自动任务或执行生产备份。

VPS 本轮仅只读核验：应用/数据库健康，回环 HTTPS 200，无公网80/443/3000/5432/Docker API；现有本地加密仓库6个文件、28,250 bytes及2026-11-07成功回执仍在。没有传送云密钥、停止服务、改动原卷、备份或定时器。新增云端测试在本机Docker执行，不是VPS自动异地备份已安装。

本地最终验证：`npm run check` 退出0（335项，329通过，6项原有Linux专属用例在Windows跳过，后续Linux CI执行）；定向备份/OSS合同14项通过、ESLint退出0。`npm run test:backup:oss` 与 `npm run test:production:release` 均退出0，后者实际执行通用S3、PostgreSQL、媒体、HTTPS、浏览器、权限/Session失效、密钥轮换和发布回退。新增真实OSS模式没有默认接入CI，以免CI持有云密钥；本地OSS协议模拟与其安全合同已接入完整CI。

CI [42474418048](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42474418048) 的 Container 首轮在恢复后应用验收失败，原日志没有具体TLS错误码，不能断言根因。检查发现恢复脚本只等CA文件出现，没有等待HTTPS就绪；已复用现有严格证书校验的就绪探针，只重试只读启动探针，不重试写入或忽略权限断言，并新增固定阶段/白名单错误诊断。本地修改后 `npm run test:production:bootstrap` 退出0，独立集群恢复耗时29.244秒，原会话/业务签名失效、权限和浏览器通过；9项已有HTTPS/保护用例及再次 `npm run check` 均通过。最终远端结果以修复后提交的完整CI为准，保留上述失败记录。
