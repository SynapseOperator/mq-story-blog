# P5-02：异地备份与负责人告警

现有 Restic、数据库/媒体一致性、固定仓库 ID、停写窗口和隔离恢复继续使用 [备份合同](PRODUCTION_BACKUP.md)。P5-01 已在真实 VPS 完成本地加密备份及新目标恢复；**同机仓库不是异地备份**。P5-02 未开通 R2、未取得真实云凭据；负责人要求本轮告警只做模拟接收，不发送真实消息。下述模板均未安装或启用。

## R2 Standard 与费用

首选独立的 **R2 Standard 私有桶**，不采用有最低保留期和读取费的 Infrequent Access。2026-11-07 官方价格：每月 10 GB-month、100 万 Class A、1000 万 Class B 免费；超出分别为 $0.015/GB-month、$4.50/百万次、$0.36/百万次，直接出站免费。存储和请求按下一计费单位上取整，免费额度不是硬预算上限，且需要考虑账号其他用量。[官方价格](https://developers.cloudflare.com/r2/pricing/)

| 两个月情景 | 条件 | 估算费用（美元） |
| --- | --- | --- |
| 每月平均 10 GB | 两个月请求均在账号剩余免费额度内 | $0 |
| 每月平均 20 GB | 同上 | $0.30 |
| 每月平均 100 GB | 同上 | $2.70 |
| 每月额外 1 个计费单位的 A 请求 | 不含存储、B 请求 | 另加 $9.00 |

估算不含税、汇率及其他服务。Restic 仓库包括数据库历史和媒体历史，不能只按当前上传文件大小估算；每天全仓 `check --read-data` 及核验恢复会增加读取次数和停写时间。实际账单需按首个仓库容量、请求量、备份窗口测算。

## 负责人在控制台完成的步骤

1. 本人登录 Cloudflare，进入 R2 Object Storage，阅读支付/计费条款后自行决定开通。R2 要先开通才可创建对应 token；不需要为备份迁移 `mq-story.xyz` 的 DNS。[R2 接入](https://developers.cloudflare.com/r2/get-started/s3/)
2. 建立只用于本项目备份的独立桶，选择 Standard。不要开启 `r2.dev` 或自定义公共域名，不配置自动删除 Restic 对象的生命周期规则。[私有/公共访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)
3. Manage API Tokens → Create Account/User API token → **Object Read & Write** → **Apply to specific buckets only** → 仅该桶。不要使用 Admin Read & Write、全账号或全部桶权限。该静态凭据的权限边界是桶，不是 prefix；因此必须使用专用桶。Restic 需要对象读写、列表及锁文件操作，不能用只读凭据执行正常备份。[R2 权限](https://developers.cloudflare.com/r2/api/tokens/)
4. Secret Access Key 只显示一次。通过本机安全交互保存到 Git 外的文件，不放聊天、Git、截图、shell 参数或命令历史。格式仅为 `accessKeyId`、`secretAccessKey`（如选用短期凭据，可有 `sessionToken`）的 JSON。Linux 文件 0400/0600、父目录 0700；Windows 需另行核验 ACL。
5. 单独生成并离线保管 Restic 密码，不复用数据库、认证、代理或业务签名秘密。R2 凭据和 Restic 密码不能只存在同一 VPS。仓库含账号与可能有效的 Session Token，解密密码按高敏感级别管理。
6. 仅向 Agent 提供已完成状态、非秘密 endpoint/bucket 和秘密文件绝对路径；**不得通过聊天发送 key/password**。供应商初始化和真实合成备份/恢复仍需明确授权，不能由“已开通”推导出可操作真实仓库。

普通区域 endpoint 为 `https://<32位accountId>.r2.cloudflarestorage.com`，region 为 `auto`。有地域约束的桶必须使用对应 `eu`/`us`/`fedramp` endpoint。现有工具对识别出的 R2 端点强制 `auto`、系统 CA 和标准 HTTPS 端口；其他 S3 隔离实验仍可显式使用测试 CA。

非秘密环境示例（替换占位内容后再验收，不包含实际凭据）：

```sh
MQ_BACKUP_BACKEND=s3
MQ_BACKUP_REPOSITORY=s3:https://ACCOUNT_ID.r2.cloudflarestorage.com/DEDICATED_BUCKET/production
MQ_BACKUP_S3_REGION=auto
MQ_BACKUP_S3_CREDENTIALS_FILE=/etc/mq/secrets/backup-s3.json
MQ_BACKUP_PASSWORD_FILE=/etc/mq/secrets/restic-password
MQ_BACKUP_REPOSITORY_ID=VERIFIED_64_HEX_REPOSITORY_ID
```

生产 wrapper 仍拒绝自动 S3 init。负责人授权后，使用固定 Restic 版本在新桶/新 prefix 初始化一次并记下仓库 ID；之后每次备份/核验/恢复都先解密配置并匹配 ID。不要在失败后换路径重试、自动 init 或删除仓库。[Restic S3 与密码合同](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#s3-compatible-storage)

## 真正异地验收和轮换

- 先以合成环境完成真实远端备份，获得唯一成功 receipt；从与源数据不同的空数据库和私有媒体根恢复。比较 dump/清单/文件 SHA-256，验证故事、权限、旧 Session 拒绝及 HTTPS。记录整个停写窗口、远端吞吐与恢复时长。此前 Moto/S3 及同机 Restic 结果不能替代此项。
- 每日备份、重大升级前另备份。现有定时模板默认为主机时区 03:30，执行前需确认香港主机时区与负责人维护时间。RPO 24 小时、RTO 4 小时是待实测的目标。
- 保留预览仍为 7 daily / 8 weekly，仅 `forget --dry-run`。不执行自动 `forget`/`prune`；历史不足时实际保留数量不同，容量不足需负责人批准后调整，不直接删除。
- 检查每次退出码、成功 receipt、仓库 ID 和 26 小时新鲜度。读取 R2 控制台容量、对象数、请求量及账单；没有 S3 通用剩余配额 API，不把本地 `statfs` 当作云容量。可在控制台查看指标，不为监控给备份凭据增加整个账号管理权限。[R2 指标](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- R2 凭据轮换：创建同一专用桶的新受限凭据 → Git 外新文件 → 在维护窗口对同一仓库 ID 核验/恢复合成快照 → 原子切换文件引用 → 再撤销旧凭据并验证拒绝。不要把新 access key 误当作新 Restic 仓库。
- Restic 密码轮换与 S3 凭据不同：须先验证新解密 key，保留必要历史恢复能力，再按单独批准步骤移除旧 key。已泄露的旧快照无法通过换密码追回；按完整数据泄露处置。现有程序没有自动轮换/删除密钥路径。

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

## 本轮可复现结果

- Windows `node --test tests/production-alert-webhook.test.mjs tests/production-external-alerts.test.mjs tests/production-operations.test.mjs tests/production-backup.test.mjs`：35 项通过，退出 0；包含真实本地 HTTPS、飞书签名/ACK、503、证书拒绝、重定向、超时、响应尺寸、CLI 默认不发送及 R2 合同。
- Linux：在现有 tools 镜像中，以非 root、只读文件系统、`--network none` 和临时目录执行同一组 35 项测试，全部通过、无跳过、退出 0；只挂载本轮脚本与测试，没有挂载秘密或 Docker socket。
- 定向 ESLint：首次因新增测试缺少 URL import 退出 1；补充显式 import 后退出 0，测试条件未变。
- 真实 R2 仓库、云端权限/配额、远端恢复、实际飞书送达、主机外探针和 systemd 安装：**尚未执行，依赖负责人操作与授权**。
- 现有 S3/Restic 数据库与媒体联合演练由完整 Container CI 继续覆盖；其最终结果以本 PR 的最新提交为准。
