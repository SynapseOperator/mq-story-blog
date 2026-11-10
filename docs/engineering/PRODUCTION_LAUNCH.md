# 生产初始化、私有验收与公网开放门禁

基础实现见 Issue #59；私有 HTTPS 验收见 Issue #65。首次空库初始化、私有验收、升级、应用回退和公网开放使用独立计划。P5-01 的真实 VPS 部署仍是合成环境；代码和合成测试不会创建正式账号、秘密、数据库或公网网站。

## 执行合同

`scripts/release/production-cli.mjs` 只在 Linux root 运维会话执行。VPS 当前为 `/opt/mq/node-v24.19.0/bin/node`；正式操作前须在 B-PREP 获准后并行安装项目批准的24.22.2、核验官方签名/摘要并切换固定路径，保留旧目录供工具回退。不在 VPS 安装 npm 开发依赖或构建源码。操作器必须来自已审核候选对应的源码；它会核对迁移、配置、私有入口模板和执行器合同与候选一致。

| 操作 | 实际顺序 | 成功后的入口 |
|---|---|---|
| bootstrap | 空目标检查 → PostgreSQL → 五类身份 → 001–009 → 11 个函数 owner/权限 → 独立业务签名 → runtime audit → 私有卷 → app 健康 → 回执 | 无代理端口，四项业务开关全部关闭；不创建管理员或数据 |
| upgrade | 近期验证备份 → 关闭入口/app → 迁移/provision/audit → 指定 digest 的 app → 健康 → 回执 | 仍关闭，须单独 activate |
| rollback | 兼容性和备份检查 → 关闭入口/app → 权限 audit → 已审核旧镜像 → 健康 → 回执 | 仍关闭，不执行 down migration 或恢复旧秘密 |
| private-preview | 关闭回执 → 独立批准 → 网络/TLS 准入 → auth-only app → 回环 TLS 代理 → HTTPS → 预览回执 | 仅 `127.0.0.1:<批准端口>`；保持正式 Origin，发布/媒体写入/留言关闭 |
| close-preview | 预览回执 → 独立批准 → 关闭代理/app → 撤销 Session → 权限 audit → 全关闭 app → 回执 | 无代理端口，须新批准才能再次预览或 activate |
| activate | 精确已部署回执 → 权限 audit → 明确选定业务开关 → 健康 → Caddy 80/443 → 公共信任链 HTTPS/公开查询 → 回执 | 仅此操作能绑定 80/443，需另外的正式上线授权 |

失败在发生服务变更后会停止代理和 app，保留 PostgreSQL、媒体卷及操作记录。若不能确认关闭，返回 `PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED`；不能把错误码当成已经安全停止。验证/只读预检失败不停止现有服务。公网入口检查使用系统证书信任与 hostname 验证；只有独立 private-preview 接受计划绑定的测试 CA，仍严格验证 hostname/信任链，不跳过 TLS 或降级 HTTP。

已公开的回执不能直接再次 activate。调整开关须先完成受控 upgrade/rollback，取得入口关闭的新回执；若回执称关闭但代理仍运行，预检拒绝并保留现场。

旧 `applySyntheticRelease` 的 production 拒绝保持不变。新入口使用独立计划、逐次批准和固定动作，不通过改环境名进入 staging，也没有任意 shell/Compose override 钩子。

## 文件与身份准备

负责人批准后，运维人员在 Git 之外准备以下文件；本轮不生成这些正式文件。所有路径须为规范绝对路径，父目录不可经符号链接替换。

- `/srv/mq-production`：root:root 0700。一个全局 `operation.lock` 串行化生产发布与定时备份；正常完成保留历史记录，失败不自动解锁。
- `/srv/mq-production/<deploymentId>`：首次 bootstrap 创建；已有目录、同名 Compose 项目、卷或网络均拒绝接管。Compose 项目固定 `mq-production`。
- 独立外部 `deployment.json`：`environment=production`、`database={host:postgres,port:5432,name:mq_production}`、正式 HTTPS origin、`media.root=/var/lib/mq/media`、至少 8 GiB 余量。角色名按 deploymentId 派生，不能复用 staging。
- 专用秘密目录：root:root 0700。`postgres_password` 属于 UID999；`database_url`、`auth_secret`、`session_storage_key`、`auth_proxy_secret`、`publish_signing_key`、`comment_signing_key`、`bootstrap_database_url`、`migration_database_url`、`role_passwords` 属于 UID10001，0400/0600、单链接、每份不超过4KiB。目录不给容器整体挂载，只逐份挂必要文件。
- `role_passwords` 使用数据库模块规定的五个身份键。数据库密码独立；认证/会话存储/代理/发布/审核五个密钥为各自独立的64位十六进制随机值。启动检查拒绝复用。这里只规定格式，不提供正式密码生成或聊天传递方式。
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
/opt/mq/node-v24.22.2/bin/node scripts/release/production-cli.mjs plan bootstrap /private/mq/settings.json

# 仅在负责人批准该精确计划后执行。
/opt/mq/node-v24.22.2/bin/node scripts/release/production-cli.mjs apply bootstrap /private/mq/settings.json \
  bootstrap:<deploymentId>:<planId>
```

外部批准记录包含且仅包含 `version:1, planId, deploymentId, sourceSha, action, approvedAt, expiresAt`，有效期最多24小时。planId 覆盖候选、配置、目标、业务开关及动作；改动后须重新计划/批准。正式上线仍需显式批准 `activate`，不能从批准 bootstrap 推定。

初始化成功保存真实 `receipt.json`；不得手写 currentRelease 或备份回执。升级/回退要求同部署、26小时内的 verified 备份，位置为目标目录 `backup-receipts/latest.json`，由已有备份工具实际产出。首次关闭入口的空库阶段按生产基础的离线备份顺序执行，不能假装定时备份的运行中三服务前提已经满足。

bootstrap 后管理员维护使用独立的交互命令：隐藏输入两次密码，重新核对 maintenance 身份和全部权限。见 [PRODUCTION_ADMIN.md](PRODUCTION_ADMIN.md)。不会复制实验账号、图片或留言。先完成受控验收，再决定正式业务开关和入口开放。

`auth=true` 会启用现有普通注册/登录合同，并非“仅管理员登录”开关。预开放测试必须保持网络入口受控；不能为了管理员验收而提前在公网启用该开关。

## 备份、互斥与失败恢复

正式备份窗口与发布共享 `/srv/mq-production/operation.lock`。并发者拿不到锁就拒绝，不能替失败的操作停止另一项服务。失败的记录保留；先核对 PID、部署 ID、实际容器及回执，再由运维人员批准恢复，不实现自动抢锁/自动恢复写入。systemd 的备份失败处理只允许关闭同一部署已经退出的备份，不接管发布锁或仍运行的进程。

所有升级默认关闭入口。失败后先确定数据库迁移、身份暂停/恢复及媒体状态；应用镜像回退只在合同兼容且备份已验证时执行。数据灾难恢复必须到新隔离目标，拒绝覆盖原库、恢复旧 Session 或旧业务签名。完整操作仍以 [SECRET_ROTATION.md](SECRET_ROTATION.md) 与 [PRODUCTION_BACKUP.md](PRODUCTION_BACKUP.md) 为准。

异地目标已改为OSS香港私有Standard/ZRS，Bucket已由负责人创建，真实合成备份与恢复已通过。专用Bucket/RAM最小权限、Restic密码、配额及7日/8周dry-run保留策略见 [OFFSITE_BACKUP_AND_ALERTS.md](OFFSITE_BACKUP_AND_ALERTS.md)。P5-03经单独授权发送一条飞书非故障测试，接口及负责人收件确认均通过；VPS自动告警与外部探针尚未启用。

## 验证边界与正式开放前事项

- 生产合同容器演练使用随机独立 PG 集群、`mq_production`、实际 production app/tools 配置、全部迁移及真实业务；仅测试代理以 staging 本地 CA 提供 HTTPS。生产代理拒绝 local TLS 的保护另行验证，没有开放80/443。
- 演练通过真实 Restic 备份取得更新回执。升级/回退覆盖固定步骤、失败闭入口和数据保留；同镜像演练不冒充跨应用版本兼容证明。P4 原候选与应用回退套件继续运行。
- 宿主机执行器的文件属主/锁/回执/固定 Docker 调用另做 Linux 临时目录测试；尚未在真实 VPS 运行本次新增 production CLI。P5-01 的真实 VPS 演练是 staging，不改称 production。
- 本轮真实 VPS 只读报告：Node24.19.0、Docker29.9.3、Compose5.7.0；应用/PG健康，代理仅127.0.0.1:18080/18443；发布和留言写入关闭，磁盘约31.34GiB可用、内存约3.01GiB可用。它是采样值，不是负载峰值或正式容量保证。
- 2026-11-07 Google DNS-over-HTTPS 实查 `mq-story.xyz` 的 A 为154.94.237.36；AAAA、CAA均返回成功查询且无记录。没有修改解析，也没有申请或验收公网证书。
- P5-04 使用独立密钥封装 Session，并由 HMAC 索引查询；009 撤销旧会话。列表、单个/其他/全部撤销在隔离框架 HTTP 中验证，生产仍保留原有路由白名单。详见 [SESSION_STORAGE.md](SESSION_STORAGE.md)。
- 正式用户开放前，负责人须处理任意 SQL 写入/完整行重放、密钥或进程失陷的残余风险：限制 runtime/backup/root访问、加密异地备份、日志隔离、泄露时撤销全部会话并轮换认证秘密。仍需独立安全 Review 和明确风险决定；测试通过不等于审查完成。
- 依赖与镜像实测见 [PRODUCTION_SECURITY_REVIEW.md](PRODUCTION_SECURITY_REVIEW.md)，最终CI结果记录在本次PR；运行时无已知 npm 告警不能推定系统镜像、离线工具和未来漏洞均安全。

P5-02 已通过独立评审并合并；真实 OSS 合成恢复也已完成。正式生产仍按下文的独立授权顺序执行，不能从代码合并推导出上线许可。

## P5-03：首次生产初始化的交接条件

2026-11-08 只读核验：现有合成 app/PostgreSQL 健康，可信本地 CA 下 `/api/stories` 返回200；Caddy仅绑定127.0.0.1:18080/18443，公网80/443/3000/5432/2375/2376均无监听。NTP已同步、UFW默认拒绝入站。可用内存3,237,253,120 bytes，磁盘33,638,969,344 bytes、可用inode4,934,472；这是一次采样，不是负载峰值。现有本地加密备份6文件/28,250 bytes的树哈希与P5-02完全相同，本轮没有修改服务、卷或备份。

同日通过Google公共DNS-over-HTTPS复核：A为154.94.237.36，AAAA/CAA均Status=0且无记录。本机系统解析返回代理保留地址，不能用它证明公共DNS异常；公共查询结果也不能替代后续公网TLS和IPv6防火墙验收。

主机仍运行 `/opt/mq/node-v24.19.0`。P5-03 候选采用更新的 Node 24 安全维护版；主机运维 Node 的安装、签名/摘要核验和固定路径切换需下轮授权，不能把候选容器升级写成 VPS 已升级。systemd 模板继续记录实际已安装路径，正式启用前须同步到获批版本。

首次生产操作按以下阶段分别审查，不沿用已过期的 P5-05B 提案或把前一阶段批准解释为后一阶段许可：

| 阶段 | 前提与授权范围 | 完成依据 |
|---|---|---|
| 安全修复 PR | 精确 HEAD 独立 Review，合并授权，main 三项 CI | 真实 merge SHA；本轮 PR 不自动合并 |
| 新候选 | 已审核 main 构建四类 OCI，另扫实际 PG 镜像 | source SHA、archive/index/manifest/config、完整扫描及分阶段风险决定 |
| B-PREP | 精确批准 Node 并行安装/固定路径、正式秘密、定点停止合成服务 | 新运行时校验；合成卷/备份保留；不构建源码、不开放端口 |
| 主机 plan | 正式配置、空目标、实际资源、临近操作的 GitHub gate | 真实 planId；gate 不超过1小时，逐动作批准不超过24小时 |
| B-BOOTSTRAP | 只批准新空库 bootstrap | 001–009、五身份/11 owner、权限 audit、健康；所有开关 false、无代理端口 |
| B-ADMIN | 独立批准现有离线维护工具及安全密码输入 | 单管理员初始化和普通用户权限边界；不复制合成账号 |
| B-PRIVATE-PREVIEW | 独立 private-preview 计划与 CA 信任范围 | 正式 Origin 的可信 HTTPS/认证/撤销/负控；结束执行获批 close-preview |
| B-BACKUP-RESTORE | 明确批准 production/ 仓库 init、首份备份和新目标恢复 | 独立 repository ID/密码、每日完整校验、精确快照、权限/旧 Session 失效；保留仍 dry-run |
| B-ACTIVATE | 前述证据完成后新 activate 计划、业务开关和80/443授权 | 公共 CA 证书、DNS/IPv6/云与主机规则、Origin/Cookie、外部探针、备份/告警定时任务验收 |

`auth=true` 同时启用普通注册，不是“仅管理员登录”。private-preview 仅启用 auth，其余三项 false；访问权限来自回环绑定与受控 SSH 转发。公网 activate 必须明确批准注册等产品开关。飞书单条真实测试已经确认送达，不需重复；自动故障通知和外部探针仍需授权并验收，不能由这条测试代替。

### 私有 HTTPS 的操作者路径

保持 `origin=https://mq-story.xyz`。为本次短期验收生成独立测试 CA 和仅含该域名的服务证书；CA 私钥离线保管，不挂入任何服务。`preview` 配置包含 `version:1`、`host:"127.0.0.1"`、1024–65535 的固定端口，以及 `ca`、`certificate`、`privateKey` 各自的绝对 `path`/SHA-256。三个文件和内容摘要参与 planId；密钥遵循原有项目外文件权限合同，只挂入 proxy，CA 仅用于验证。不能把签名私钥放入公开目录、浏览器或截图。

分别运行 `plan private-preview` / `apply private-preview`，成功后再运行经单独批准的 `plan close-preview` / `apply close-preview`，均使用现有 `production-cli.mjs` 与逐动作确认串。只允许关闭回执开启预览；预览回执不能直接 activate、upgrade 或 rollback。close-preview 关闭代理、停 app、暂停写身份、撤销会话、恢复身份并启动全关闭 app，保留数据库和媒体。失败维持入口关闭并保留操作锁，按失败阶段恢复，不能手改回执假装已关闭。

Docker 容器内 Caddy 监听443；宿主发布为 `127.0.0.1:<端口>:443`，二者不是同一个回环。执行器检查 Docker>=28、普通 NAT bridge、无 direct routing/trusted host interface、无 IPv6/host-network 绕行，以及实际发布地址。UFW 状态不能替代这些检查。[Docker 端口文档](https://docs.docker.com/engine/network/port-publishing/)

首次 bootstrap 尚未启动 proxy，因此 edge 网络可能不存在。预览先检查已有 frontend，获得精确批准后只创建停止状态的 proxy，再审核 Compose 实际创建的两个网络，最后启动入口；不能把 Docker 查询失败当作网络不存在。验收浏览器只安装锁定的 Chromium headless-shell，避免无关浏览器占满 CI 磁盘，8GiB 余量门槛保持不变。

运维电脑使用已有受信 SSH 别名，只把本机回环443转发到 VPS 的预览端口（本机443必须空闲）：`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:443:127.0.0.1:<预览端口> mq-story-vps`。在临时隔离浏览器环境将 mq-story.xyz 解析至127.0.0.1，导入并核对这次测试 CA；禁止忽略证书错误、全局污染系统信任或导入 CA 私钥。若当前平台无法实现独立信任库，使用专用隔离 Linux 浏览器容器，不修改正常浏览器的安全设置。保留 HTTPS URL、Host、SNI 和 Origin，不用 localhost 替代正式域名。

验收结束关闭 SSH 转发、销毁测试浏览器上下文/信任库，并在服务器完成 close-preview；再次确认端口关闭、旧 Session 不可用。测试 CA 成功只证明私有信任路径、Cookie 与认证合同，**不能证明公网证书签发或续期成功**。Caddy private 配置显式使用证书文件，禁用自动 HTTPS/ACME、自动重定向及系统信任安装；activate 继续使用原有公共信任链。[Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls)

资源安排：只长期运行一套MQ环境；保留合成数据并不要求保留其运行进程。常驻app/PG/proxy内存上限合计2,432MiB，离线tools再占512MiB，尚需内核、Docker和页缓存余量。先停止实验服务，再实测初始化、图片处理、备份和更新峰值。主机不构建Next源码；磁盘预检仍要求8GiB加候选归档所需余量，备份暂存容量另行检查。不能用本次空闲采样保证峰值安全。

失败时：首次bootstrap保留目标库与媒体，入口/app保持关闭，检查操作记录后向前修复，不重复接管非空目标；升级失败先确认入口确实关闭，只有合同兼容并有近期验证备份才能回退应用镜像。数据库灾难恢复始终使用新隔离目标，旧Session及业务签名不恢复。不得执行down migration或自动删除合成/正式卷来腾空间。

本轮没有生产操作授权；上述清单是下一次请求批准的具体范围。单条飞书测试送达已另行获批完成，后续自动通知、生产OSS策略应用、密钥托管、定时任务、主机运行时更新与公网TLS仍须负责人操作或单独批准。候选目录须由受控运维身份暂存并禁止非受信用户写入；操作前重新校验归档与配置摘要，不能只依赖旧的计划文件或源码标签。

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
