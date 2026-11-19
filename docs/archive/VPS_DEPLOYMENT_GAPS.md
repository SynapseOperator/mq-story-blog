# P4-02：从发布工具到真实 VPS

关联 Issue #55。本文核对已有代码与尚缺的执行条件，不是生产上线报告，也不包含 VPS 实测结论。主机容量、有效 SSH 配置及网络边界须以本轮独立只读报告为准。不得用套餐名称代替测量。

## 当前代码与发布门禁

P4-02 从 P4-01 `50e4db9f487d97aba1405d3f1f7245a399820883` 创建，依赖 [PR #54](https://github.com/SynapseOperator/mq-story-blog/pull/54)。启动时 #54 尚未合并；quality/database/container 成功，独立 APPROVED 对应旧提交 `80799cd`。两者之间只调整协作说明，不改变这个审批事实。负责人允许继续准备，不授权合并、生产部署或绕过保护。任何后续操作都须重新查询状态。

`scripts/release/gate.mjs` 要求候选是 main 上一个真实合并提交，并逐项核验：对应 PR、SnorkelingBreather 对该 PR 最终 HEAD 的 APPROVED、无有效 CHANGES_REQUESTED、无未解决线程，以及该 main SHA 最新 quality/database/container 全部成功。**即使未来单独批准一次合并审查例外，也不会让候选构建自动通过精确提交审批门禁。** 本轮不修改这个门禁，也不向协作者发送通知。

`.github/workflows/release-candidate.yml` 尚需进入默认分支后才能执行其手动入口。只构建私有 OCI 下载产物，不部署。main 上的旧版本、未合并分支及合成实验成功不能作为 P4 候选已获放行的证据。

## A．已有实现，仍需目标环境验收

| 能力与代码接点 | 真实环境要补的证据 |
| --- | --- |
| 原生只读采集 `scripts/production/host-preflight-native.sh`；本地 importer 复用 `assessHostPreflight` | 真实容量、监听、时间与AppArmor已采集，见 [VPS_READINESS.md](VPS_READINESS.md)；SSH Match/UFW等仍待特权只读核验。不能据 UFW 一项认定 Docker 或云防火墙安全。 |
| 多阶段 `Dockerfile`、`compose.production.yaml`、Caddy 私有代理头边界 | 官方 Docker/Compose 安装及版本、containerd image store、非 root/只读容器、私网、HTTPS 与伪造代理头拒绝；当前没有安装许可。 |
| `database-cli.mjs` 的 bootstrap/migrate/provision/keys/audit | 空目标库、001–008、五类登录身份、11 个 NOLOGIN 函数 owner 和运行身份审计；每次仅挂载本次维护身份。不能用 superuser 验证运行权限。 |
| 文件秘密与 manifest 校验、`init-media.mjs`、卷初始化 | 私有目录和 UID10001 权限、部署标记、PG18 持久卷、重建持久化、低磁盘拒写。正式文件/密钥尚未配置。 |
| OCI 全层校验、digest 记录与 Docker load 合成验收 | 真正候选 workflow、可信下载摘要、归档传输及实机 OCI 加载，确认主机存储后端而非自动切换。 |
| `backup-window.mjs`、Restic 本地/S3、隔离恢复与轮换 | 真正异地端点、IAM、TLS、流量、容量、维护窗口、恢复时间；首次只用合成数据。实际账号和备份不得进 Artifact。 |
| `ops/` 的定时模板与脱敏告警、运维健康检查 | 用户选定接收端、送达测试、告警恢复、定时器权限与失败闭入口；模板存在不表示已启用任务。 |

## B．仍需代码或配置，不能直接启用

| 缺口 | 最小后续工作与验收 |
| --- | --- |
| 首次部署不是现有更新计划 | `scripts/release/deploy.mjs` 的 `planRelease` 必须同时取得 currentRelease 和同 deploymentId 的近期完整备份（≤26 小时）。空主机没有这两项，禁止伪造 receipt。先按 `PRODUCTION_FOUNDATION.md` 的空库顺序编排受审首次安装计划，记录每一步目标、身份与失败停止点。 |
| 生产 apply 明确拒绝 | `applySyntheticRelease` 仅接受随机 staging 库和 `.localhost`。未来实现生产执行器必须单独授权、Review、隔离演练；不能删掉 `RELEASE_PRODUCTION_APPLY_NOT_AUTHORIZED` 检查来启用。必须实际验证关闭入口、停止 app、迁移/审计、健康验收和失败闭入口。 |
| 主机运维协调器的安装/封装 | 原生预检无需远端 Node，但现有 release/backup 协调器是 Node 24 程序；`ops/mq-backup@.service` 明确调用 `/usr/bin/node`。Docker 镜像内有 Node 不等于宿主已有它。后续在受审宿主 Node 运行时与经测试的容器协调器之间选一条，不能直接启用当前模板。原预检的 Node 缺失阻塞保持不变，另列硬件结果。 |
| 主机专用配置 | 确定 deploymentId、单套 Compose project、精确镜像摘要、域名、卷/秘密/备份目录与受控维护 override。只验证结构不生成正式凭据；默认业务开关继续关闭。 |
| 更新和回退的主机接线 | 当前应用回退要求迁移、Schema、权限、秘密、内容、Compose 合同完全一致。需保存已验证 current/candidate、关闭入口和恢复记录。数据库降级、恢复旧秘密不属于镜像回退。 |
| 容量与备份规模 | 根据实测可用空间限制数据库/媒体增长，并验证备份的 dump 上限、全库校验时间、外网速度和维护停写窗口。超限时评审具体方案，不能降低余量门槛。 |
| 独立产物信任与长期保留 | 当前只有来自可信 Actions run 的摘要及 blob 校验，无独立签名/attestation 验证；Artifact 保留 1 天。确定候选长期保存与可信摘要交接方法，不把同一未知下载里的 checksum 当作信任根。 |

## 资源预算：先保留现有限制

以下来自 `compose.production.yaml`，不是目标 VPS 的性能测量：

| 服务 | 内存上限 | CPU 上限 | 说明 |
| --- | --- | --- | --- |
| Next.js app | 1536 MiB | 2 | 两个 64 MiB tmpfs；实际内存仍需在上传、哈希、业务并发下测量 |
| PostgreSQL 18 | 768 MiB | 1 | shared_buffers=192MB、work_mem=4MB、max_connections=40；work_mem 不是全实例总额 |
| Caddy | 128 MiB | 0.5 | 16 MiB tmpfs；80/443 为唯一应用公网映射 |
| tools，按需 | 512 MiB | 1 | 不常驻；运维任务及镜像导入另有宿主开销 |

常驻上限合计 **2432 MiB / 3.5 CPU**；与 tools 同时运行为 **2944 MiB / 4.5 CPU**，CPU 限制是竞争上限，不是为每个容器预留核心。容器内存上限也不替代宿主峰值、缓存和 OOM 实测。4GB 计划下不建议长期并行 staging 与 production，不在 VPS 执行 Next.js 源码构建。Swap 是缓冲，不能替代内存容量。

数据库卷挂载 PG18 的 `/var/lib/postgresql` 父目录；媒体、Caddy data/config 分卷。日志每服务 `10m × 3` 轮转，仍须监控宿主 journal、Docker 元数据和运维临时文件。

磁盘必须同时容纳 OS、当前镜像、回退镜像、四份下载归档、数据库、媒体、日志及备份工作区。四份 OCI 归档会重复保存共享层；不能把四个 `docker image inspect .Size` 相加当作物理占用，也不能只看 app 镜像。候选下载、导入后保留旧版本和备份核验的峰值须实测；不使用全局 prune 解决空间问题。

现有备份空间检查有明确公式，见 `backup.mjs`、`backup-tools.mjs`：

```text
D = pg_database_size(目标库)
M = 本次 READY 素材展示图与缩略图实际字节总数
工作区所在文件系统可用空间 >= 3 × (D + M) + 256 MiB
```

本地 Restic 仓库也执行同一准入；同一磁盘不会因此预留两份独立容量，实际还要计入历史备份。**使用 S3 仍需要上述本地工作区**，因为备份包含导出、媒体复制和独立恢复核验。工具目前限制 dump 为 512 MiB、单个子工具默认超时 300 秒，并执行 Restic 全数据校验。这些均需用计划数据规模验证，不能用小合成样本的秒级结果承诺真实 RTO。

例如旧规划若达到数据库 5 GiB + 媒体 10 GiB，仅备份准入即需额外空闲 45.25 GiB，无法适配总盘约 40GB。该规划不能作为可用配额。初期应严格控制实际数据量、将长期备份放异地，并依据实测逐步确定上限；更大规模需要扩大独立工作空间或单独评审备份流程。保留运维 8 GiB 余量门槛；媒体 `minFreeBytes` 是另一项拒写保护，既非硬配额，也不保证其他进程不会耗尽磁盘。

## C．负责人需要选择的外部条件

| 选择 | 所需结果 |
| --- | --- |
| `mq-story.xyz` 注册局审核与 DNS | 从注册商确认可用状态；核验权威 NS、A/AAAA/CAA 后再计划解析。没有经过 IPv6 验收，不发布 AAAA；不假定注册审核或证书已经成功。 |
| 异地 Restic/S3 | 选择独立于 VPS 故障域、两个月费用可接受的端点，明确存储/请求/出站费与最小 IAM。默认每日、7 日/8 周保留目前只 dry-run，不启用真实删除。 |
| 告警接收方式 | 确认渠道、接收人和频率，然后单独授权真实送达测试；不擅自向协作者或未知 webhook 发消息。 |
| 运维和恢复材料 | 决定受控保存镜像摘要、备份密码、恢复说明的方式及权限；备份含认证与可能有效的 Session Token。原值 Token 风险仍需负责人和独立安全审查处置。 |

## D．必须单独批准的真实服务器操作

| 操作 | 执行前须提交的具体内容 |
| --- | --- |
| SSH、UFW/云防火墙、IPv6 与系统更新 | 以真实只读结果拟定精确规则、来源、受影响入口和 VNC 回退。先验证第二密钥会话，再收紧；考虑 ssh.socket 与 Docker 发布端口。当前密码已由负责人轮换，不重复列为“尚未轮换”。 |
| 安装 Docker/Compose/协调器 | 官方来源、锁定版本、磁盘/内存影响、重启与回退方案。不能为预检安装 Node，也不自动切换 Docker storage driver。 |
| 正式秘密、身份和持久卷初始化 | 每次准确目标、身份、权限与备份边界；不在聊天收集密码或私钥，不复用实验秘密。 |
| 域名解析、ACME 签发、开放 80/443 | 先验收主机与代码门禁，再确认域名、入口和受控验证方式；VPS 已购买不等于已授权公网开放。 |
| 首次部署、管理员创建及业务开关 | 使用已审核候选和明确维护窗口，先关闭入口完成检查；逐项授权，不自动开放注册、留言或发布。 |
| 定时备份、真实告警、保留删除和恢复 | 明确对象、权限、维护停写影响与故障恢复；任何覆盖/删除均另行确认，不恢复到现有未知数据库。 |

下一步依据已完成的只读报告，由负责人确认主机加固和组件安装方案，再安排受控实机合成演练。P4-01 的审批、main CI、真实候选运行、正式秘密、异地恢复和最终安全验收必须分别完成；本轮准备工作不代替任何一项。
