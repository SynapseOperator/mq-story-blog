# P5-02：生产初始化与开放门禁

关联 Issue #59。本增量把首次空库初始化、日常升级、应用回退和公网开放分成四种明确操作；不替换 P4 的合成部署工具，也不自动执行真实生产操作。P5-01 已在真实 VPS 完成隔离部署与恢复；本轮只读复核仍是合成环境、回环入口，正式账号、秘密、数据库和公网网站均未创建。

## 执行合同

`scripts/release/production-cli.mjs` 只在 Linux root 运维会话执行。Node 固定使用现有 `/opt/mq/node-v24.19.0/bin/node`，不在 VPS 安装 npm 开发依赖或构建源码。操作器必须来自已审核候选对应的源码；它会核对当前代码的迁移与配置合同和候选一致。

| 操作 | 实际顺序 | 成功后的入口 |
|---|---|---|
| bootstrap | 空目标检查 → PostgreSQL → 五类身份 → 001–008 → 11 个函数 owner/权限 → 独立业务签名 → runtime audit → 私有卷 → app 健康 → 回执 | 无代理端口，四项业务开关全部关闭；不创建管理员或数据 |
| upgrade | 近期验证备份 → 关闭入口/app → 迁移/provision/audit → 指定 digest 的 app → 健康 → 回执 | 仍关闭，须单独 activate |
| rollback | 兼容性和备份检查 → 关闭入口/app → 权限 audit → 已审核旧镜像 → 健康 → 回执 | 仍关闭，不执行 down migration 或恢复旧秘密 |
| activate | 精确已部署回执 → 权限 audit → 明确选定业务开关 → 健康 → Caddy 80/443 → 公共信任链 HTTPS/公开查询 → 回执 | 仅此操作能绑定 80/443，需另外的正式上线授权 |

失败在发生服务变更后会停止代理和 app，保留 PostgreSQL、媒体卷及操作记录。若不能确认关闭，返回 `PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED`；不能把错误码当成已经安全停止。验证/只读预检失败不停止现有服务。入口检查使用系统证书信任与 hostname 验证，不接受测试 CA、跳过验证或 HTTP 降级。

已公开的回执不能直接再次 activate。调整开关须先完成受控 upgrade/rollback，取得入口关闭的新回执；若回执称关闭但代理仍运行，预检拒绝并保留现场。

旧 `applySyntheticRelease` 的 production 拒绝保持不变。新入口使用独立计划、逐次批准和固定动作，不通过改环境名进入 staging，也没有任意 shell/Compose override 钩子。

## 文件与身份准备

负责人批准后，运维人员在 Git 之外准备以下文件；本轮不生成这些正式文件。所有路径须为规范绝对路径，父目录不可经符号链接替换。

- `/srv/mq-production`：root:root 0700。一个全局 `operation.lock` 串行化生产发布与定时备份；正常完成保留历史记录，失败不自动解锁。
- `/srv/mq-production/<deploymentId>`：首次 bootstrap 创建；已有目录、同名 Compose 项目、卷或网络均拒绝接管。Compose 项目固定 `mq-production`。
- 独立外部 `deployment.json`：`environment=production`、`database={host:postgres,port:5432,name:mq_production}`、正式 HTTPS origin、`media.root=/var/lib/mq/media`、至少 8 GiB 余量。角色名按 deploymentId 派生，不能复用 staging。
- 专用秘密目录：root:root 0700。`postgres_password` 属于 UID999；`database_url`、`auth_secret`、`auth_proxy_secret`、`publish_signing_key`、`comment_signing_key`、`bootstrap_database_url`、`migration_database_url`、`role_passwords` 属于 UID10001，0400/0600、单链接、每份不超过4KiB。目录不给容器整体挂载，只逐份挂必要文件。
- `role_passwords` 使用数据库模块规定的五个身份键。数据库密码独立；四个应用/代理/发布/审核秘密为各自独立的64位十六进制随机值。启动检查拒绝复用。这里只规定格式，不提供正式密码生成或聊天传递方式。
- maintenance、backup 连接与 Restic 密码另行隔离保存，仅挂载对应离线工具，不能给 app。具体合同见 [生产基础](PRODUCTION_FOUNDATION.md)、[管理员维护](PRODUCTION_ADMIN.md)和[备份](PRODUCTION_BACKUP.md)。

宿主 root 和 Docker 控制者属于可信运维边界；文件属主检查不能防御已经取得 root 的攻击者。生产签名密钥从外部文件初始化，历史 SQL 迁移没有密钥内容，001–008 未改动。

## 候选、计划与批准

在受信运维电脑使用既有 `release-candidate.yml` 构建已审核 main SHA，校验四份 OCI。摘要应来自对应 GitHub run 的可信 Summary，不是同一未知下载附带的文本。传输后重新核对 archive/index/manifest/config 摘要。

临近操作时，在运维电脑运行现有 `scripts/release/cli.mjs gate <sourceSha> <newGateFile>`。它实时查询 main 祖先、对应合并 PR、精确 HEAD 独立 APPROVED、未解决线程及三项 CI。GitHub token 只在该电脑进程使用，不能传到 VPS。将非秘密 gate 文件传入 root 只读配置；主机要求它匹配候选，且检查时间不超过1小时。该文件是运维交接证据，不是数字签名；控制主机 root 的人仍必须遵守人工门禁。

外部 settings 的字段固定为：

```json
{
  "version": 1,
  "targetDirectory": "/srv/mq-production/<deploymentId>",
  "deploymentFile": "/private/mq/deployment.json",
  "secretDirectory": "/private/mq/secrets",
  "candidateDirectory": "/private/mq/release",
  "candidateManifestSha256": "<trusted-64-hex-sha256>",
  "gateFile": "/private/mq/current-github-gate.json",
  "approvalFile": "/private/mq/approval.json",
  "features": {"auth": false, "media": false, "publishing": false, "comments": false}
}
```

上例是字段说明，含占位符，不能直接运行。settings/gate/approval/deployment 按既有外部配置读取规则保护。bootstrap 的 features 必须全 false。确认文本和计划摘要均是非秘密，但不能代替负责人批准。

```sh
# 只读计划，不启动容器、不写主机文件。
/opt/mq/node-v24.19.0/bin/node scripts/release/production-cli.mjs plan bootstrap /private/mq/settings.json

# 仅在负责人批准该精确计划后执行。
/opt/mq/node-v24.19.0/bin/node scripts/release/production-cli.mjs apply bootstrap /private/mq/settings.json \
  bootstrap:<deploymentId>:<planId>
```

外部批准记录包含且仅包含 `version:1, planId, deploymentId, sourceSha, action, approvedAt, expiresAt`，有效期最多24小时。planId 覆盖候选、配置、目标、业务开关及动作；改动后须重新计划/批准。正式上线仍需显式批准 `activate`，不能从批准 bootstrap 推定。

初始化成功保存真实 `receipt.json`；不得手写 currentRelease 或备份回执。升级/回退要求同部署、26小时内的 verified 备份，位置为目标目录 `backup-receipts/latest.json`，由已有备份工具实际产出。首次关闭入口的空库阶段按生产基础的离线备份顺序执行，不能假装定时备份的运行中三服务前提已经满足。

bootstrap 后管理员维护使用独立的交互命令：隐藏输入两次密码，重新核对 maintenance 身份和全部权限。见 [PRODUCTION_ADMIN.md](PRODUCTION_ADMIN.md)。不会复制实验账号、图片或留言。先完成受控验收，再决定正式业务开关和入口开放。

`auth=true` 会启用现有普通注册/登录合同，并非“仅管理员登录”开关。预开放测试必须保持网络入口受控；不能为了管理员验收而提前在公网启用该开关。

## 备份、互斥与失败恢复

正式备份窗口与发布共享 `/srv/mq-production/operation.lock`。并发者拿不到锁就拒绝，不能替失败的操作停止另一项服务。失败的记录保留；先核对 PID、部署 ID、实际容器及回执，再由运维人员批准恢复，不实现自动抢锁/自动恢复写入。systemd 的备份失败处理只允许关闭同一部署已经退出的备份，不接管发布锁或仍运行的进程。

所有升级默认关闭入口。失败后先确定数据库迁移、身份暂停/恢复及媒体状态；应用镜像回退只在合同兼容且备份已验证时执行。数据灾难恢复必须到新隔离目标，拒绝覆盖原库、恢复旧 Session 或旧业务签名。完整操作仍以 [SECRET_ROTATION.md](SECRET_ROTATION.md) 与 [PRODUCTION_BACKUP.md](PRODUCTION_BACKUP.md) 为准。

真实 R2 尚未开通。专用 Bucket/Object Read & Write、Restic 密码、配额及7日/8周 dry-run 保留策略见 [OFFSITE_BACKUP_AND_ALERTS.md](OFFSITE_BACKUP_AND_ALERTS.md)。模拟 S3 恢复不能替代实际 R2 副本恢复。告警本轮仅向隔离模拟接收端发送，未配置真实收件人。

## 验证边界与正式开放前事项

- 生产合同容器演练使用随机独立 PG 集群、`mq_production`、实际 production app/tools 配置、全部迁移及真实业务；仅测试代理以 staging 本地 CA 提供 HTTPS。生产代理拒绝 local TLS 的保护另行验证，没有开放80/443。
- 演练通过真实 Restic 备份取得更新回执。升级/回退覆盖固定步骤、失败闭入口和数据保留；同镜像演练不冒充跨应用版本兼容证明。P4 原候选与应用回退套件继续运行。
- 宿主机执行器的文件属主/锁/回执/固定 Docker 调用另做 Linux 临时目录测试；尚未在真实 VPS 运行本次新增 production CLI。P5-01 的真实 VPS 演练是 staging，不改称 production。
- 本轮真实 VPS 只读报告：Node24.19.0、Docker29.9.3、Compose5.7.0；应用/PG健康，代理仅127.0.0.1:18080/18443；发布和留言写入关闭，磁盘约31.34GiB可用、内存约3.01GiB可用。它是采样值，不是负载峰值或正式容量保证。
- 2026-11-07 Google DNS-over-HTTPS 实查 `mq-story.xyz` 的 A 为154.94.237.36；AAAA、CAA均返回成功查询且无记录。没有修改解析，也没有申请或验收公网证书。
- Better Auth1.7.12 仍原值保存 Session Token。实际15组Spike发现简单摘要适配不能兼容列表/单个/其他设备撤销；没有接入不可靠的哈希替换。应用只开放既有认证白名单，不提供框架 Session 列表或任意撤销端点。详见 [SESSION_TOKEN_SPIKE.md](SESSION_TOKEN_SPIKE.md)。
- 正式用户开放前，负责人须处理 Session 数据泄露残余风险：限制 runtime/backup/root访问、加密异地备份、日志隔离、泄露时撤销全部会话并轮换认证秘密。仍需独立安全 Review 和明确风险决定；测试通过不等于审查完成。
- 依赖与镜像实测见 [PRODUCTION_SECURITY_REVIEW.md](PRODUCTION_SECURITY_REVIEW.md)，最终CI结果记录在本次PR；运行时无已知 npm 告警不能推定系统镜像、离线工具和未来漏洞均安全。

下一轮顺序：完成本PR独立审查与授权合并 → 生成新main候选 → 用户完成R2和真实告警选择/送达测试 → 批准正式目标及秘密托管 → 保留当前合成卷并定点停止实验服务以控制资源峰值 → 空库bootstrap及管理员交互初始化 → 受控验收和真实异地恢复 → 另行批准公网80/443、DNS/TLS与业务开关 → activate和外部验收。此处是待执行清单，不是生产上线记录。

## 本轮执行证据（2026-11-07）

| 本地命令/环境 | 实际结果 |
|---|---|
| `npm run check` | 修复终端回显时序后重新退出0：lint、Schema、typecheck、327项单测中321通过/6项Windows不适用、生产构建；POSIX/TTY项由Linux单独执行和最终CI覆盖 |
| `test:production:db`、`test:production:admin`、`test:production:rotation`、`test:auth:session-spike` | 均退出0；随机真实PG18库；管理员维护、密钥/会话轮换与15组Session对照 |
| `test:db`、`test:auth`、`test:admin`、`test:admin-drafts`、`test:admin-editor`、`test:admin-preview`、`test:public`、`test:likes`、`test:comments` | 均退出0；实际数据库、HTTP/HTTPS及既有浏览器回归 |
| `test:media`、`test:media:upload`、`test:media:stories`、`test:publishing`、`test:media:lifecycle` | 均退出0；图片/历史引用/公开隔离、发布与原备份恢复套件保留 |
| `test:production:bootstrap` | 退出0；production合同空库、10项真实业务与浏览器、独立集群恢复、同镜像升级/回退及故障拒绝。最终包装镜像一轮完整恢复30.331秒为本机实测，不是VPS RTO承诺 |
| `test:production:operations`、`test:production:release` | 均退出0；前者本地Restic备份/恢复5.639/2.335秒；后者隔离模拟S3 HTTPS备份/恢复8.870/4.403秒，真实加密、错误凭据拒绝、保留策略仅dry-run |
| `test:release` | 退出0；OCI archive/index/manifest/config分别核验，实际按digest加载执行 |
| Linux root文件/锁/计划套件 | 39/39通过、退出0、0skip；真实临时文件权限，Docker命令边界为测试替身，不冒充实机CLI执行 |
| 打包后的Linux主机/HTTPS/告警套件 | 39/39通过、退出0、0skip；模拟接收端，无真实通知 |

本轮保留了失败记录：一次本地媒体TLS回归运行期间发生构建重叠，完成独立构建后串行完整重跑通过；新外部探针在隧道连接时未保留HTTP Host，真实容器回归捕获后补修并增加TLS用例；Linux镜像测试发现备份服务模板被构建白名单排除，现仅补入三个非秘密模板。原失败记录保存在Git外，不通过删测、放宽TLS或降低磁盘阈值消除失败。

首轮 [CI 42361773174](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42361773174) 的真实 Linux PTY 测试捕获密码回显竞态：既有隐藏输入函数先显示提示，随后才关闭内核回显。修复后先关闭回显并准备读取，再显示提示。增加提示写出后的80ms调度窗口，旧版稳定失败，修复后连续30次真实PTY（60次密码提示）通过；没有打印合成密码或放宽原断言。另补引导 PostgreSQL 密码的32–128字符校验，与其他数据库密码一致；Linux root真实秘密文件/发布测试19项通过。两项修复不改变业务认证或数据库权限。

截图、备份演练与扫描原始材料留在本机私有实验目录；备份、凭据和浏览器状态不上传CI Artifacts。最终Linux Quality/Database/Container必须对应本PR最终提交，结果见PR链接；这里的本地通过不能替代该门禁。
