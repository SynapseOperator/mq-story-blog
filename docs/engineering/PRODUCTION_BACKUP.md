# 加密备份与隔离恢复

P3-03 / Issue #51 使用 PR #50 的显式部署身份。`scripts/production/backup-cli.mjs` 是新的受控入口；原 `media:backup` 的 localhost/dev/test 限制保持不变。这里没有正式服务器、真实照片或正式备份密码。

## 选择与一致性边界

采用 **Restic 0.19.1 + PostgreSQL 18 原生 custom-format pg_dump**。Restic 提供加密、认证、内容去重与仓库校验；不自行设计密码格式。首版 wrapper 只接受本地、已存在的 0700 仓库目录。未来可把已加密仓库复制到离机存储，或经过权限/故障测试后支持 Restic 的远端 backend；当前没有采购、连接云存储或证明异地恢复。[Restic 备份](https://restic.readthedocs.io/en/stable/040_backup.html)、[仓库检查](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)。

首版采用短维护窗口：停止 app 与所有维护写进程，执行受控 `pause`，四个写身份变为 NOLOGIN 并确认没有活动连接；backup 身份仍只能读取。备份持有与轮换/恢复共享的 `mq-production-maintenance-v1` advisory lock，阻止受控 resume 或轮换插入窗口。备份查询与原生 pg_dump 使用同一个导出 snapshot；PENDING/DELETING 素材导致失败，须先走既有恢复流程，不能猜测或改成 READY。

媒体和数据库复制不占用 `withAdmin` 事务。备份专用只读快照在有限的维护窗口内保持；写身份排空保障文件复制不会遇到业务删除。宿主机 root、DB bootstrap 和同 UID 的不受控直接文件修改仍属受信运维边界，不能靠 advisory lock 阻止。不要在备份期间手工改库或移动文件。

包含 public、发布私有 Schema、留言审核私有 Schema 的完整数据库、READY 展示图/缩略图、全部素材清单、数据库及文件 SHA-256/尺寸、8 个迁移与应用 commit 标识。不含原始照片，因为系统本来不保存原图。清单与从 dump 恢复的数据库再次对比，防止文件和记录错配；READY 不代表公开，原有 Revision/发布权限关系完整保留。

`restic backup` 的任何非零退出（包括部分成功）都算失败。成功后执行 `restic check --read-data`，将精确 snapshot 再提取到新目录，检查 dump、清单和每张图片；最后才生成成功 receipt。receipt 是不含账号数据的 `{verified,snapshotId,completedAt,deploymentId,sourceRevision,assets,files}`。不使用 `latest` 猜测恢复点，不把存在某个 snapshot 等同于该次备份成功。

## 身份和秘密

- Bootstrap 文件连接只负责校验目标、控制维护锁和恢复后的权限收口；pg_dump 只使用 backup 只读身份。
- pg_restore 使用新目标的 migration 身份，不能作为 superuser 导入 SQL。备份只能来自受信仓库；Restic 密码持有者能创建新的可信密文，认证不等于外部独立签名。
- Restic 密码从独立 0400/0600 文件读取，不与仓库或工作目录重叠，不在 argv 中传值。子进程使用允许列表环境，PG 密码仅进入对应工具进程环境，不继承其他维护秘密；stdout/stderr 不转发路径、SQL、凭据或正文。
- 仓库、工作目录、receipt 父目录必须在 Git 外，禁止链接路径，POSIX 0700。备份保存身份信息、密码哈希、可能仍有效的 Session Token 和两类签名密钥；取得备份密码等同于取得这些敏感内容。
- 密码另行离线保管，不能只留在同台 VPS 或同一个备份卷。丢失密码无法恢复；备份密码泄露必须按完整数据泄露处理，单纯换密码不能收回已复制的历史数据。

## 命令顺序

使用 `operations` 镜像（PG18.6、Node24、Restic0.19.1），以 UID10001 运行。Compose 不自动挂载 bootstrap、backup 或仓库密码；操作员只给本次命令需要的只读秘密文件和准确卷。

公共非秘密配置：`MQ_DEPLOYMENT_CONFIG`、`MQ_DEPLOYMENT_ENV`、`MQ_BACKUP_REPOSITORY`、`MQ_BACKUP_WORKSPACE`。秘密路径：`MQ_BACKUP_PASSWORD_FILE`；备份另需 `BOOTSTRAP_DATABASE_URL_FILE`、`BACKUP_DATABASE_URL_FILE`；恢复另需新目标的 `BOOTSTRAP_DATABASE_URL_FILE`、`RESTORE_MIGRATION_DATABASE_URL_FILE`。不可提供原始同名秘密变量或 Restic password-command。

所有命令必须明确 `--confirm-deployment=<manifest中的UUID>`，包括 staging；这是防误操作，不是生产授权。示例只表示调用顺序，不能直接对未知主机执行：

```sh
# 仅首次，对人工准备的空私有仓库目录执行；失败不自动重新 init。
node scripts/production/backup-cli.mjs init --confirm-deployment=<部署ID>

# 停 app/写入任务，按 rotation CLI 执行 pause 并确认排空后：
# MQ_BACKUP_SOURCE_REVISION 是受审完整40位commit；MQ_BACKUP_RECEIPT 是本次唯一新文件。
node scripts/production/backup-cli.mjs backup --confirm-deployment=<源部署ID>

# MQ_BACKUP_SNAPSHOT 设置为成功receipt中的完整64位ID；核对源manifest。
node scripts/production/backup-cli.mjs verify --confirm-deployment=<源部署ID>

# 单独准备新部署ID、空数据库、全新角色，执行bootstrap，但不执行migrate；
# 准备全新空0700媒体根；改用目标manifest及目标秘密后：
node scripts/production/backup-cli.mjs restore --confirm-deployment=<目标部署ID>
```

不接受重用源 deploymentId。新主机的 production 数据库仍可叫 `mq_production`：隔离由新部署 ID/tag、准确连接、空对象检查和空媒体根共同确定，不要求改生产数据库名。工具不会 DROP、`--clean`、覆盖现有库/根或强制终止未知连接。

恢复暂时只允许目标 migration 身份连接；完成 pg_restore 后再次 NOLOGIN，撤销 PUBLIC 权限，清空所有 Session 及两张签名密钥表。数据库历史内容和管理员授权保留，但旧会话不能复活，旧发布/审核证明失效。恢复成功仍是 **writers paused / service disabled / requires provisioning**，不是重新开放许可。

接着保持目标 app/其他工具停止，显式 `resume` 后再用 bootstrap 运行 `provision`：新目标尚未授予 runtime/维护/backup CONNECT，LOGIN 恢复本身并不授予访问权；既有 provision 的完整矩阵审计要求最终 LOGIN 状态，因此不能颠倒这两个步骤。provision 原子设置新 owner/列权限，失败不启动应用。准备新的认证、代理及业务密钥，按独立授权初始化两类业务密钥；运行 runtime audit 后才在隔离网络启动应用。正式重新开放前须验证旧 Cookie/旧签名被拒绝、新登录、公开/私有图片、发布和审核权限及备份恢复结果。不要直接复用源环境秘密来恢复业务开放。

## 故障、空间与重复运行

单次 pg_dump 上限 512MiB、清单最多10000素材、单图片4MiB；超限拒绝，不输出完整标记。工作区/仓库都保守预留三倍 DB 估算大小与媒体字节数，加256MiB余量，覆盖同盘导出、核验提取和加密写入。它不是硬配额，磁盘可能被其他程序占用；真实写失败返回非零。40GB主机不宜长期保留同盘全量副本。

每次备份生成独立 UUID 工作子目录和新 receipt。重跑会生成新 snapshot，Restic 去重；不覆盖旧 receipt，不自动 forget/prune/unlock。失败或进程中断没有新成功 receipt，写身份继续关闭，已提交快照不能冒充本轮验收成功。

成功后只删除该次函数亲自创建、验证过路径的明文 export/verify 子目录，保留加密仓库；恢复完成也清理该次提取目录。失败可能保留私有明文工作子目录用于诊断，操作员须在确认归属后处理；不自动清理未知文件或根目录。这不是 SSD 安全擦除，主机磁盘加密与物理访问仍须控制。告警监控应同时检查命令退出码、唯一 receipt、最后成功时间及磁盘余量，不能只检查 cron 是否运行。

损坏、缺失、错误仓库密码、路径混用、已有目标、未排空写连接、权限漂移和缺少确认均失败关闭。恢复失败的新库/新目录保留停用，不尝试修复或破坏既有开发/生产库；在人工确认前不能 resume。

## 本轮证据和未完成项

自动化入口与真实计时由 `test:production:operations` 的隔离容器演练生成：合成账号、公开/私有图文和留言 → 加密备份 → 新目标恢复 → 权限/约束/数据核验 → 实际 HTTPS 应用启动。测试产物只输出计时、数量、固定错误码和合成页面证据，不上传数据库、Restic 仓库、密码或密文备份到 CI Artifacts。

2026-11-06 Windows Docker Desktop 的 Linux 容器完整演练退出 0：Restic 0.19.1、PostgreSQL 18.6；2 个 READY 素材、4 个私有文件随数据库恢复，8 个迁移及 11 个函数 owner/权限重新核验。备份含完整校验耗时 6.167 秒，恢复命令 2.462 秒，恢复开始到 HTTPS 可服务 17.824 秒。恢复后桌面 1536×1024 和手机 390×844（DPR 2）实际解码图片；旧 Cookie 拒绝，私有草稿/图片仍不可匿名读取。随后 5 个数据库口令、认证/代理与两类业务密钥轮换验证通过。

这是小型合成数据、Windows 宿主上的 Linux 容器结果，不是 4GB VPS 的性能或恢复时间承诺。本地 CA 签发的 12 小时证书触发了预期的临期告警，未降低正式监控阈值。首次演练发现原生 pg_restore 需显式 `--dbname`，第二次发现恢复后 LOGIN 状态与既有权限审计顺序不一致；两项修正后重新执行了完整演练，未放宽权限检查。

容器 CI 输出脱敏的监控数值。共享 runner 刚构建镜像后的宿主高负载不作为未来 VPS 的容量验收，但必须真实产生 `HOST_LOAD_HIGH`，保留 `monitoring.ok=false`；生产探针仍非零退出。容器健康、磁盘、端口、备份和证书验证异常依旧使演练失败，不能用 CI 成功替代主机健康验收。

Linux CI 的一次真实失败显示磁盘仅余 8,039,165,952 bytes，低于 8GiB 保留线。构建改为本次 job 独占的 BuildKit builder，四个镜像导出后删除其专属缓存，再运行演练；不降低磁盘阈值、不执行全局 prune 或删除 runner 的无关目录。

仅清缓存后仍约余 7.6GiB，因此离线 tools/operations 改为共享 PG18、Node 和工程依赖层，operations 只额外添加 Restic，避免两次保存相同依赖。应用镜像不变；两种维护镜像继续使用 UID10001，需通过完整迁移、权限、备份恢复及轮换演练。

最终命令退出码和 Linux CI 链接以 PR 验证记录为准。真实异地仓库、保留周期/RPO/RTO批准、定时调度告警接收者、磁盘配额、生产备份密钥托管/签名和真实VPS恢复仍待上线前验收。
