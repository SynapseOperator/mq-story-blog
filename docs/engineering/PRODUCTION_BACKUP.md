# 加密备份与隔离恢复

P3-03 / Issue #51 使用 PR #50 的显式部署身份；P4 / Issue #53 在该合同上增加 S3 后端和保留策略预览。`scripts/production/backup-cli.mjs` 是受控入口；原 `media:backup` 的 localhost/dev/test 限制保持不变。P5-01 后已完成真实 VPS 的隔离部署和同机加密备份/恢复，见 [VPS 实测](VPS_ISOLATED_DEPLOYMENT.md)；P5-02 又完成真实 OSS 合成备份及隔离恢复，但尚无正式生产仓库、密码或已启用的定时任务。详见 [外部服务验收](OFFSITE_BACKUP_AND_ALERTS.md)。下文保留各阶段的合成验证边界。

## 选择与一致性边界

采用 **Restic 0.19.1 + PostgreSQL 18 原生 custom-format pg_dump**。Restic 提供加密、认证、内容去重与仓库校验；不自行设计密码格式。操作员必须显式选择 `local` 或 `s3`：本地仓库仍须为 Git 外的 0700 目录；S3 只连接预先初始化、具有固定仓库 ID 的 HTTPS 地址。真实 OSS 合成恢复已验证，不代表生产备份已配置。[Restic 备份](https://restic.readthedocs.io/en/stable/040_backup.html)、[仓库检查](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)。

采用维护窗口：停止 app 与所有维护写进程，执行受控 `pause`，四个写身份变为 NOLOGIN 并确认没有活动连接；backup 身份仍只能读取。备份持有与轮换/恢复共享的 `mq-production-maintenance-v1` advisory lock，阻止受控 resume 或轮换插入窗口。备份查询与原生 pg_dump 使用同一个导出 snapshot；PENDING/DELETING 素材导致失败，须先走既有恢复流程，不能猜测或改成 READY。当前停写覆盖远端传输、完整仓库检查和恢复校验；不能将小型本地演练时间当作真实 S3 停机时长。

媒体和数据库复制不占用 `withAdmin` 事务。备份专用只读快照在有限的维护窗口内保持；写身份排空保障文件复制不会遇到业务删除。宿主机 root、DB bootstrap 和同 UID 的不受控直接文件修改仍属受信运维边界，不能靠 advisory lock 阻止。不要在备份期间手工改库或移动文件。

包含 public、发布私有 Schema、留言审核私有 Schema 的完整数据库、READY 展示图/缩略图、全部素材清单、数据库及文件 SHA-256/尺寸、8 个迁移与应用 commit 标识。不含原始照片，因为系统本来不保存原图。清单与从 dump 恢复的数据库再次对比，防止文件和记录错配；READY 不代表公开，原有 Revision/发布权限关系完整保留。

`restic backup` 的任何非零退出（包括部分成功）都算失败。成功后执行 `restic check --read-data`，将精确 snapshot 再提取到新目录，检查 dump、清单和每张图片；最后才生成成功 receipt。receipt 是不含账号数据的 `{verified,snapshotId,completedAt,deploymentId,sourceRevision,assets,files,backend}`，S3 另记录非秘密 `repositoryId`。不使用 `latest` 猜测恢复点，不把存在某个 snapshot 等同于该次备份成功。

## 身份和秘密

- Bootstrap 文件连接只负责校验目标、控制维护锁和恢复后的权限收口；pg_dump 只使用 backup 只读身份。
- pg_restore 使用新目标的 migration 身份，不能作为 superuser 导入 SQL。备份只能来自受信仓库；Restic 密码持有者能创建新的可信密文，认证不等于外部独立签名。
- Restic 密码从独立 0400/0600 文件读取，不与仓库或工作目录重叠，不在 argv 中传值。子进程使用允许列表环境，PG 密码仅进入对应工具进程环境，不继承其他维护秘密；stdout/stderr 不转发路径、SQL、凭据或正文。
- 仓库、工作目录、receipt 父目录必须在 Git 外，禁止链接路径，POSIX 0700。备份保存身份信息、密码哈希、可能仍有效的 Session Token 和两类签名密钥；取得备份密码等同于取得这些敏感内容。
- 密码另行离线保管，不能只留在同台 VPS 或同一个备份卷。丢失密码无法恢复；备份密码泄露必须按完整数据泄露处理，单纯换密码不能收回已复制的历史数据。

## S3 文件秘密与仓库合同

S3 使用 `s3:https://<endpoint>/<bucket>/<专用非空prefix>`，通用S3固定path-style；OSS香港自动使用dns虚拟主机与Restic文档的oss-cn-hongkong region，其他阿里Endpoint拒绝。所有S3均显式region、最多 2 个连接及有界重试。拒绝 HTTP、URL 账号密码、查询参数、编码/相对路径和任意 Restic 选项。正式端点使用系统可信 CA；隔离实验可显式提供只读 CA 文件，不存在跳过 TLS 校验开关。[官方 S3 合同](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#s3-compatible-storage)。

凭据文件为 Git 外的 0400/0600 JSON，仅接受 `accessKeyId`、`secretAccessKey` 和可选 `sessionToken`。每个字段必须为非空无空白 ASCII 字符串，文件最多 4096 bytes；不支持 INI、`credential_process`、角色跳转或默认 AWS/MinIO 凭据。内容只装入对应 Restic 子进程的 AWS 环境变量，不进入 Compose 环境、镜像、argv 或日志。同 UID/主机 root 仍可能读取进程环境；这不抵御主机失陷。

S3 `init` 在生产 wrapper 中明确拒绝。负责人需另行批准供应商、预建 bucket/prefix、最小权限与初始化，并记录 Restic 仓库完整 64 位 ID。正常备份、核验、恢复和保留策略预览均先解密 `cat config` 并匹配该 ID；错密码、错 prefix、错仓库不会触发初始化。对象读取/写入与锁管理权限应限定到专用 prefix，不授予应用账号、bucket 创建或管理权限。真实供应商 IAM、流量费及配额仍需实测，协议模拟不证明这些条件。

P5-03 将 S3 **写入**环境与前缀绑定：production 只能写入精确的 `BUCKET/production` 仓库；staging 不能写入 `production` 或其子路径。写入口会拒绝混用，备份窗口也在停止 app 前检查。仓库 ID 仍单独固定，不能靠相同前缀冒充同一仓库。`verify`、`restore` 读取的是显式确认的旧源，不能用新目标的环境或部署 ID 改写源地址；恢复后的新备份重新遵循写入合同。本地仓库合同保持不变。

生产监控必须配置 `MQ_OPS_BACKUP_BACKEND=s3` 和精确的 `MQ_OPS_BACKUP_REPOSITORY_ID`。只有同一 deployment、该 backend/repositoryId、verified=true、完整 snapshot ID 的私有回执才能更新备份新鲜度；本地成功回执或另一个仓库的新回执不代表异地备份正常。监控只读不含秘密的回执，不需要 AccessKey；凭据失效由下一次真实备份的非零退出和失败通知检测，不能声称仅查回执就完成了云端探活。

备份 API 继续支持原有内部本地调用，但 CLI 不接受缺失的后端选择，也不会因看到 URL 就自动切换到 S3。

## 命令顺序

使用 `operations` 镜像（PG18.6、Node24、Restic0.19.1），以 UID10001 运行。Compose 不自动挂载 bootstrap、backup 或仓库密码；操作员只给本次命令需要的只读秘密文件和准确卷。

公共非秘密配置：`MQ_DEPLOYMENT_CONFIG`、`MQ_DEPLOYMENT_ENV`、`MQ_BACKUP_BACKEND=local|s3`、`MQ_BACKUP_REPOSITORY`、`MQ_BACKUP_WORKSPACE`。秘密路径：`MQ_BACKUP_PASSWORD_FILE`；备份另需 `BOOTSTRAP_DATABASE_URL_FILE`、`BACKUP_DATABASE_URL_FILE`；恢复另需新目标的 `BOOTSTRAP_DATABASE_URL_FILE`、`RESTORE_MIGRATION_DATABASE_URL_FILE`。S3 另外必需 `MQ_BACKUP_REPOSITORY_ID`、`MQ_BACKUP_S3_REGION`、`MQ_BACKUP_S3_CREDENTIALS_FILE`，可选 `MQ_BACKUP_CA_CERT_FILE`。不可提供原始数据库秘密、AWS/MinIO 凭据或 Restic password-command。

所有命令必须明确 `--confirm-deployment=<manifest中的UUID>`，包括 staging；这是防误操作，不是生产授权。示例只表示调用顺序，不能直接对未知主机执行：

```sh
# 仅首次，MQ_BACKUP_BACKEND=local，对人工准备的空私有仓库目录执行。
# S3 仓库须另行批准并预先初始化；失败不自动重新 init。
node scripts/production/backup-cli.mjs init --confirm-deployment=<部署ID>

# 停 app/写入任务，按 rotation CLI 执行 pause 并确认排空后：
# MQ_BACKUP_SOURCE_REVISION 是受审完整40位commit；MQ_BACKUP_RECEIPT 是本次唯一新文件。
node scripts/production/backup-cli.mjs backup --confirm-deployment=<源部署ID>

# MQ_BACKUP_SNAPSHOT 设置为成功receipt中的完整64位ID；核对源manifest。
node scripts/production/backup-cli.mjs verify --confirm-deployment=<源部署ID>

# 单独准备新部署ID、空数据库、全新角色，执行bootstrap，但不执行migrate；
# 准备全新空0700媒体根；改用目标manifest及目标秘密后：
node scripts/production/backup-cli.mjs restore --confirm-deployment=<目标部署ID>

# 只展示计划，不删除 snapshot、不 prune，也不需数据库维护凭据：
node scripts/production/backup-cli.mjs retention-plan --confirm-deployment=<源部署ID>
```

不接受重用源 deploymentId。新主机的 production 数据库仍可叫 `mq_production`：隔离由新部署 ID/tag、准确连接、空对象检查和空媒体根共同确定，不要求改生产数据库名。工具不会 DROP、`--clean`、覆盖现有库/根或强制终止未知连接。

恢复暂时只允许目标 migration 身份连接；完成 pg_restore 后再次 NOLOGIN，撤销 PUBLIC 权限，清空所有 Session 及两张签名密钥表。数据库历史内容和管理员授权保留，但旧会话不能复活，旧发布/审核证明失效。恢复成功仍是 **writers paused / service disabled / requires provisioning**，不是重新开放许可。

接着保持目标 app/其他工具停止，显式 `resume` 后再用 bootstrap 运行 `provision`：新目标尚未授予 runtime/维护/backup CONNECT，LOGIN 恢复本身并不授予访问权；既有 provision 的完整矩阵审计要求最终 LOGIN 状态，因此不能颠倒这两个步骤。provision 原子设置新 owner/列权限，失败不启动应用。准备新的认证、代理及业务密钥，按独立授权初始化两类业务密钥；运行 runtime audit 后才在隔离网络启动应用。正式重新开放前须验证旧 Cookie/旧签名被拒绝、新登录、公开/私有图片、发布和审核权限及备份恢复结果。不要直接复用源环境秘密来恢复业务开放。

## 故障、空间与重复运行

单次 pg_dump 上限 512MiB、清单最多10000素材、单图片4MiB；超限拒绝，不输出完整标记。工作区及本地仓库都保守预留三倍 DB 估算大小与媒体字节数，加256MiB余量，覆盖同盘导出、核验提取和加密写入。S3 只对本地工作区执行该检查，不把远端地址传入 `statfs`。S3 可用配额没有通用文件系统查询，必须通过实际供应商另行监控；远端拒写、断流或超时均失败，不产生成功 receipt。此准入检查不是硬配额，磁盘仍可能被其他程序占用。40GB主机不宜长期保留同盘全量副本。

每次备份生成独立 UUID 工作子目录和新 receipt。重跑会生成新 snapshot，Restic 去重；不覆盖旧 receipt，不自动删除 snapshot、prune 或 unlock。失败或进程中断没有新成功 receipt，写身份继续关闭，已提交快照不能冒充本轮验收成功。

保留预览固定为 **7 daily / 8 weekly**，只接受 `forget --dry-run`，按当前 deployment 的 host/tag 过滤并按 `host,tags` 分组。随机 export 目录会进入 snapshot 的绝对路径元信息，所以不能使用默认的 host/paths 分组。输出只含保留及候选删除的完整 snapshot ID，不输出文件路径，也不估算已释放空间。Restic 在历史不足时可能额外保留最早的 snapshot；“7 daily”按有备份的日历天计算，不保证正好七份。没有匹配 snapshot 时只返回空计划。[官方保留语义](https://restic.readthedocs.io/en/stable/060_forget.html)。

成功后只删除该次函数亲自创建、验证过路径的明文 export/verify 子目录，保留加密仓库；恢复完成也清理该次提取目录。失败可能保留私有明文工作子目录用于诊断，操作员须在确认归属后处理；不自动清理未知文件或根目录。这不是 SSD 安全擦除，主机磁盘加密与物理访问仍须控制。告警监控应同时检查命令退出码、唯一 receipt、最后成功时间及磁盘余量，不能只检查 cron 是否运行。

损坏、缺失、错误仓库密码、路径混用、已有目标、未排空写连接、权限漂移和缺少确认均失败关闭。恢复失败的新库/新目录保留停用，不尝试修复或破坏既有开发/生产库；在人工确认前不能 resume。

## 定期备份：默认未启用

`scripts/production/backup-window.mjs` 提供固定维护顺序，`ops/mq-backup@.service` / `.timer` 是尚未安装的模板。它不是直接对运行中数据库执行 backup 的 cron：

1. 从 Git 外的只读窗口配置、部署 manifest 和私有 Compose env 文件读取目标。确认 UUID、`mq-staging|mq-production` 项目、配置挂载、现有 app/proxy/postgres 容器标签及镜像 digest；未知、已停止或不健康的初始目标拒绝。
2. production 先独占 `/srv/mq-production/operation.lock`，与发布共享；再创建本部署的 `backup-window.lock`。已有锁拒绝新的调度，不停止另一项操作。先停止 proxy/app，再调用已有 rotation CLI `pause`，由数据库核验写身份排空。
3. 调用原 backup CLI；仅在其成功且真实 receipt 可读、部署 ID、snapshot 和源 commit 一致后，原子更新同部署 `latest.json`。
4. 成功才 `resume` 和 `up --wait app proxy`。任何失败或中断尝试关闭入口并再次 pause；未能确认关闭时输出 `closureConfirmed=false`，必须立即人工处理，不能宣称已经安全关闭。失败保留锁；不会自行重试、删除快照或解锁。

准备配置时，复制 `ops/backup-window.example.json` 与 `ops/backup-compose.example.yaml` 到 Git 外，替换明确的目标并核验所有 image digest。模板中的 `REPLACE_WITH_CONFIRMED_DEPLOYMENT_UUID` 故意无效。运维主机需要 Node 24、Docker Compose 及对应受审源码；Docker 操作身份属于主机高权限边界。Compose override 只给 tools 挂载本次维护秘密、工作区与 receipt 目录，并为 S3 提供出站网络，不发布端口。工作区和 status 目录须为 UID10001 的 0700 目录。既有正式应用不挂载这些维护秘密。

负责人批准主机连接、停机窗口和第一次手工演练后，才可安装实例化的 systemd 单元。`/etc/mq/backup/<部署ID>.env` 只包含路径，例如：

```text
MQ_BACKUP_WINDOW_CONFIG=/etc/mq/backup/window.json
```

这些文件须由可信运维人员维护；配置及 override 只读，Compose env 为 0400/0600。服务还要求显式的 `/etc/mq/backup/<部署ID>.enabled` 标记。定时器示例在主机时区 03:30 运行，有 5 分钟随机延迟，须先确认业务可接受的时区与维护时间；`Persistent=false` 避免开机立即补跑造成意外停机。本轮不复制到 `/etc/systemd/system`，不创建 enabled 标记，不 enable 或 start 任何真实服务。

服务的 `ExecStopPost` 在失败时重新核对目标并只执行关闭入口/pause，成功时不再操作。`OnFailure` 通过实例 UUID 调用告警 CLI 的 `--backup-failure`，生成当前时间的固定 `BACKUP_FAILED` 信封；不读取可能缺失或过期的 `backup-failure.json`，该文件仅保留作故障诊断。告警默认仅 dry-run；尚未配置和实际验证通知接收者时，不得声称告警会送达。需要真实通知时，须另行批准 webhook 文件及 `--send`。[Ubuntu 24.04 的服务退出清理语义](https://manpages.ubuntu.com/manpages/noble/man5/systemd.service.5.html)。

运维监控读取配置的 receiptDirectory 中 `latest.json`；它只证明最近一次备份完整，不证明应用随后恢复成功，仍须核对服务退出状态与入口健康。失败后检查固定错误阶段、容器状态、DB 写身份与遗留工作目录；确认没有在途备份/维护操作并获得恢复批准后，才可移除**这个部署的空 `backup-window.lock` 目录**，将匹配本次操作的全局 `operation.lock` 保留归档，再按 rotation 手册人工恢复。不能只移除局部锁就重复执行，也不能接管活跃进程或其他部署/发布的锁。不要删除整个 status/workspace，不用 Restic unlock 掩盖未完成的维护。

协调器的状态机、真实 receipt 文件发布、错误目标拒绝和中断行为已有自动化测试。工具容器以 UID10001 写入 0600 receipt，主机 root 用专门的有界元数据读取器接收；秘密文件读取规则没有放宽。读取器拒绝符号链接、硬链接、其他用户归属和宽松权限。注入的 Docker runner 测试不等同于目标 VPS 的 systemd 演练。真正安装、时间窗口、进程强杀/重启恢复及通知送达仍需主机验收。

## 本轮证据和未完成项

自动化入口与真实计时由 `test:production:operations` 的隔离容器演练生成：合成账号、公开/私有图文和留言 → 加密备份 → 新目标恢复 → 权限/约束/数据核验 → 实际 HTTPS 应用启动。测试产物只输出计时、数量、固定错误码和合成页面证据，不上传数据库、Restic 仓库、密码或密文备份到 CI Artifacts。

2026-11-06 Windows Docker Desktop 的 Linux 容器完整演练退出 0：Restic 0.19.1、PostgreSQL 18.6；2 个 READY 素材、4 个私有文件随数据库恢复，8 个迁移及 11 个函数 owner/权限重新核验。备份含完整校验耗时 6.167 秒，恢复命令 2.462 秒，恢复开始到 HTTPS 可服务 17.824 秒。恢复后桌面 1536×1024 和手机 390×844（DPR 2）实际解码图片；旧 Cookie 拒绝，私有草稿/图片仍不可匿名读取。随后 5 个数据库口令、认证/代理与两类业务密钥轮换验证通过。

这是小型合成数据、Windows 宿主上的 Linux 容器结果，不是 4GB VPS 的性能或恢复时间承诺。本地 CA 签发的 12 小时证书触发了预期的临期告警，未降低正式监控阈值。首次演练发现原生 pg_restore 需显式 `--dbname`，第二次发现恢复后 LOGIN 状态与既有权限审计顺序不一致；两项修正后重新执行了完整演练，未放宽权限检查。

容器 CI 输出脱敏的监控数值。共享 runner 刚构建镜像后的宿主高负载不作为未来 VPS 的容量验收，但必须真实产生 `HOST_LOAD_HIGH`，保留 `monitoring.ok=false`；生产探针仍非零退出。容器健康、磁盘、端口、备份和证书验证异常依旧使演练失败，不能用 CI 成功替代主机健康验收。

Linux CI 的一次真实失败显示磁盘仅余 8,039,165,952 bytes，低于 8GiB 保留线。构建改为本次 job 独占的 BuildKit builder，四个镜像导出后删除其专属缓存，再运行演练；不降低磁盘阈值、不执行全局 prune 或删除 runner 的无关目录。

仅清缓存后仍约余 7.6GiB，因此离线 tools/operations 改为共享 PG18、Node 和工程依赖层，operations 只额外添加 Restic，避免两次保存相同依赖。应用镜像不变；两种维护镜像继续使用 UID10001，需通过完整迁移、权限、备份恢复及轮换演练。

最终命令退出码和 Linux CI 链接以 PR 验证记录为准。真实异地仓库、保留周期/RPO/RTO批准、定时调度告警接收者、磁盘配额、生产备份密钥托管/签名和真实VPS恢复仍待上线前验收。

P4 定向验证已执行：Windows `node --test tests/production-backup.test.mjs tests/production-backup-window.test.mjs` 10/10；Linux UID10001 的真实 Restic 0.19.1 本地工具测试 7/7，包括保留策略跨随机目录分组及 dry-run 前后快照不变。S3 与全部数据库/HTTPS 联合结果以 P4 最终 PR 的演练记录为准，不以这些本地工具测试代替真实云仓库验收。

补充 Linux 身份边界验证：UID1001 运行窗口测试 5/5；root 运行 `scripts/production/backup-window-root-tests.mjs` 6/6，其中实际启动 UID10001 子进程生成 receipt，验证 root 协调器可完成恢复入口；通用秘密读取器仍拒绝该跨 UID 文件。错误 owner、0644、硬链接与符号链接均拒绝。以上命令均退出 0；这项验证覆盖真实文件所有权，不替代尚未执行的 VPS systemd 服务安装与运行。
