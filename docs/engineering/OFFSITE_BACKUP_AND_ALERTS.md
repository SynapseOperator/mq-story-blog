# P5-02：异地备份与负责人告警

2026-11-08 负责人决定：Cloudflare R2 因支付绑定失败不再作为目标，改用 **Alibaba Cloud OSS，中国香港，Standard + ZRS，私有 Bucket**。此前没有建立 R2 仓库，因此没有数据迁移。Restic 客户端加密、数据库/媒体一致性、固定仓库 ID、停写窗口和隔离恢复仍遵守 [备份合同](PRODUCTION_BACKUP.md)。负责人已创建 `mq-story-backups`，确认 Standard + ZRS、Private、版本控制关闭，专用 RAM 身份为 `mq-story-backup`。本轮先完成安全文件交接及真实合成备份/恢复；不上传个人数据，不安装正式定时任务。Bucket 属性目前为负责人控制台确认，不能以 Restic 成功访问代替整桶策略审计。告警继续只验证模拟接收。

## OSS 接入合同

使用项目锁定的 Restic 0.19.1 官方 Alibaba 示例组合：

- Repository：`s3:https://oss-cn-hongkong.aliyuncs.com/BUCKET/production`
- Restic region：`oss-cn-hongkong`；不是 R2 的 `auto`。
- Bucket lookup：固定 `dns`，实际请求由 Restic 使用 `BUCKET.oss-cn-hongkong.aliyuncs.com`。
- 标准 HTTPS/系统 CA；拒绝自定义 CA、非标准端口、内部/其他地域 Endpoint、重复 Bucket 子域名和带点 Bucket 名。

阿里云当前 AWS SDK 指南另有 `s3.oss-{region}.aliyuncs.com` 与 `cn-hongkong` 的组合。本工具不混配这两套配置，也不在签名失败时自动换 Endpoint/region。真实 OSS 签名、RAM 和读写兼容性仍须在 Bucket 创建后验证。[锁定 Restic 文档](https://github.com/restic/restic/blob/v0.19.1/doc/030_preparing_a_new_repo.rst#alibaba-cloud-aliyun-object-storage-system-oss)、[OSS virtual-hosted 要求](https://www.alibabacloud.com/help/en/oss/developer-reference/compatibility-with-amazon-s3)、[当前 AWS SDK 接入指南](https://www.alibabacloud.com/help/en/oss/developer-reference/use-aws-sdks-to-access-oss)

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
- 真正异地验收：合成数据备份至实际私有OSS → 从云端恢复至不同的空数据库/媒体目录 → 对比dump/清单/文件SHA-256 → 验证旧Session失效、权限、HTTPS、公开与私有媒体。记录停写窗口、传输量和恢复时长。当前本地模拟不能替代此项。
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

当前没有配置真实 webhook、邮箱或接收人。邮箱方案需负责人已有的受控 SMTP/邮件 API，不能擅自以个人 Gmail 发通知或新建账号。本轮按最新选择 **只执行本地 HTTPS 模拟接收**。

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

VPS 本轮仅只读核验：应用/数据库健康，回环 HTTPS 200，无公网80/443/3000/5432/Docker API；现有本地加密仓库6个文件、28,250 bytes及2026-11-07成功回执仍在。没有传送云密钥、停止服务、改动原卷、备份或定时器。新增云端测试在本机Docker执行，不是VPS自动异地备份已安装。

本地最终验证：`npm run check` 退出0（335项，329通过，6项原有Linux专属用例在Windows跳过，后续Linux CI执行）；定向备份/OSS合同14项通过、ESLint退出0。`npm run test:backup:oss` 与 `npm run test:production:release` 均退出0，后者实际执行通用S3、PostgreSQL、媒体、HTTPS、浏览器、权限/Session失效、密钥轮换和发布回退。新增真实OSS模式没有默认接入CI，以免CI持有云密钥；本地OSS协议模拟与其安全合同已接入完整CI。
