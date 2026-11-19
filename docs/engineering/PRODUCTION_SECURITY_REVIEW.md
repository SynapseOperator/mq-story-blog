# 生产候选安全审查

## P5-05C：出站 TLS 修复与私有验收边界

关联 Issue #65。基线为 main `7f25366e8b1d5702a1dd3e93f2e2d5438b8fcee2` 和正式候选 run `42558766333`；基线五镜像合计13 Critical / 284 High包匹配。本次修复必须由新 PR 的独立 Review、main CI 和新正式候选接续，不能继续部署旧 operations 摘要，也不能把本分支的本地候选标为已审核 main。

Restic0.19.1 官方成品仍使用 Go1.26.4，受 [GO-2026-6809 / CVE-2026-111943](https://pkg.go.dev/vuln/GO-2026-6809) 影响；[上游问题](https://github.com/restic/restic/issues/22132)尚未提供本次可直接使用的修复成品。更新系统 CA 可去除信任库中的受损锚，但不能覆盖应用自定义信任锚等所有验证路径。实际公共证书负控证明：旧 Go 接受、Go1.27.3 即使显式信任该锚也拒绝。没有关闭 TLS 校验或通过忽略 CVE 消除告警。

采用 **MQ patched rebuild**：校验发行源包、独立 PGP 指纹和 SHA-256，固定官方 Go1.27.3镜像，保持 Restic Go 源码不变，仅对 `go.mod/go.sum` 应用可审查补丁。`x/net`0.62.0 修复实际 S3 HTTP/2 transport，`klauspost/compress`1.20.2 修复实际仓库压缩路径；相应 x/* 最低依赖闭包逐项记录。补丁前后锁文件校验、`go mod verify`、断网构建、真实 buildinfo、负控及双向旧仓库恢复防止把未验证重编译当维护版。来源与版本见 [provenance](../../ops/restic-source-provenance.json)；该二进制**不是官方发行包**，工具链和旧负控 binary 不进入最终 operations 镜像。

私有预览不开放新的生产认证路由。正常公开白名单下验证登录、Secure/HttpOnly/Lax Cookie、Origin/CSRF、普通/管理员权限及退出；列表、单个/其他/全部设备撤销继续由真实框架 PostgreSQL/HTTP Session 套件验证。close-preview 撤销全部实际 Session，再次打开预览时旧 Cookie 仍须失效。测试 CA 与公网公共证书分别验收。

只读辅助复核 Agent `p505c_independent_review` 未编写生产执行器，审查 plan/host/CLI、Caddy/秘密挂载、兼容性摘要和关闭路径，发现并推动修复 Docker `iptables=false` 可绕过回环发布的 P1 准入缺口。修复后 Linux root 的62项合同/文件/真实TLS测试退出0、0skip；Windows保留原有Linux专属检查，由Linux补测。该复核不是 SnorkelingBreather 的 APPROVED，也未在真实 VPS 执行生产操作。

本机 Docker Desktop 的 host-gateway 能转发到宿主回环端口，负控失败必须保留为非零/部分验收，不能用 Windows 后端证明 Ubuntu 防火墙。原生 Linux CI 的网络隔离断言仍须真实通过；测试适配执行器也不代替未来 VPS 上真实 production host 的预检和 apply。

分阶段结论：关闭公网的空库 bootstrap 可在新候选、精确批准、网络/权限准入及容量检查后提出有限执行建议；首次生产 OSS 备份还需新的 operations 二进制、完整 S3 TLS/错误凭据/恢复证据和专属仓库授权；公网 activate 另需处理剩余 Caddy、系统库及数据库原生功能风险、云规则、正式证书、外部探针和自动备份告警。**三个阶段均没有从本轮测试自动取得生产许可。** 全部五类最终扫描、退出码和对应摘要随本次 PR 的证据提供；已知漏洞不改写为退出0。

## P5-04：会话存储变更

PR #62 已普通合并为 `c1de9981a5310ee634919e8a8036dc76b7a4911f`，main 的 [42493637189](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42493637189) 三项检查成功。以下 P5-03 扫描与原值存储实验是历史证据，不代表本次候选镜像或认证代码已经通过审批。

本分支新增 009 和受支持的数据库 adapter：独立密钥、AES-256-GCM 封装、HMAC 查询索引及身份/期限 AAD；数据库不再保存有效 Token 明文。27 项真实 PostgreSQL/HTTP 检查覆盖原生列表和撤销、更新/事务、泄露、篡改、原生删除与管理员撤权的并发顺序。详见 [Session 安全存储](SESSION_STORAGE.md)。这不是简单摘要替换，也没有开放额外生产认证路径。

独立只读 Agent `p504_runtime_plan` 未参与核心 codec/adapter 编写，复核了它们、009、认证入口、测试及既有锁顺序，未发现阻塞性认证绕过；该 Agent 也参与运维接线，不冒充 GitHub 协作者 APPROVED。完整有效旧行与原 Cookie 同时被攻击者持有时仍可重放原身份；数据库任意写入、密码哈希篡改、应用密钥/进程失陷不因此被解决。短表锁会串行 Session 更新/撤销；当前 MQ 禁止自动刷新，未来启用或扩容须重新评估。

P5-03 镜像漏洞、主机/公网验收与正式独立安全评审仍是单独门槛。本轮不操作 VPS、不启用生产业务、不发送告警。

## P5-03：历史结论（2026-11-08）

PR #60 的精确HEAD独立审批与三项CI复核后，以普通merge合并为 `2dc86a9039a364e9348277a8b8a5196a3b35c6dd`；合并后的 [Quality 42479369327](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42479369327) quality/database/container全部成功。本轮P5-03是其后的独立增量，没有生产部署授权。

已采用官方Node 24.22.2固定镜像与npm11.21.2，保持Node24/npm11、Next16、Prisma7及001–008不变。Node更新包含24.22.1的安全维护；npm更新替换内置旧tar/undici依赖，没有手改npm内部文件或强制覆盖应用锁文件。VPS主机运维Node仍为24.19.0，未作远端升级。[Node维护记录](https://nodejs.org/en/blog/release/v24.22.1)、[24.22.2](https://nodejs.org/en/blog/release/v24.22.2)、[npm版本](https://github.com/npm/cli/releases/tag/v11.21.2)

Session Token仍原值存库。新增真实PostgreSQL/HTTP反例表明：任意运行身份SQL写能力可以重绑自己已有的签名Cookie，摘要存储也不能保护该身份映射；没有发现SQL注入或因此放宽权限。原有摘要候选仍不能正确单个/其他设备撤销，不能接入实际认证。登录、多个设备、列表、撤销、退出、过期、密钥轮换等16组测试通过；测试风险反例的PASS不是修复。完整威胁及补偿措施见 [Session报告](../archive/SESSION_TOKEN_SPIKE.md)。

备份新增生产/合成写前缀隔离，生产监控必须匹配S3仓库ID，拒绝把本地或其他仓库的新鲜回执当作异地成功。全量check、snapshot验证和保留dry-run不变。飞书一次送达测试经负责人单独批准，接口成功且负责人确认收件；没有启用真实timer或把凭据传到VPS。详见 [备份与告警](OFFSITE_BACKUP_AND_ALERTS.md)。

### 入口与权限定向复核

| 边界 | 本轮复核与已有强制规则 | 不能推出的结论 |
| --- | --- | --- |
| 管理权限 | `withAdmin`在同一锁定事务内重新读取数据库Session、用户与AdminGrant；撤权/过期/故障拒绝 | 不能抵御整个运行数据库写身份或主机被控制 |
| 认证与Cookie | 四条公开认证路径白名单、服务端身份、HTTPS/Secure/HttpOnly/SameSite、Origin/CSRF和共享原子限流；不扩大框架原生端点 | 不承诺被盗有效Cookie不可重放，也没有生产DDoS容量结论 |
| 图片与正文 | 解码/尺寸/字节限制、私有存储、读前后鉴权、当前公开Revision与READY关系、GET/HEAD/no-store；文件I/O不占用授权事务 | 不把READY或随机路径当公开授权，不宣称历史图片自动可见 |
| 发布与审核 | 独立HMAC、会话/授权再校验、CAS和数据库函数限制；留言先PENDING，只有审核后公开 | 应用运行账号没有直接更新发布字段/授权/历史引用的权力 |
| 日志和秘密 | 既有固定错误码、PostgreSQL DETAIL限制、文件秘密、恢复清Session/业务密钥；代理覆盖伪造头 | root/应用身份仍能读取其必要秘密；备份内容仍敏感 |
| 容器和入口 | 非root app/proxy、PG与app不发布端口、分网络、默认业务关闭；真实VPS只读仍为回环HTTPS | 没有实际公网证书、正式Origin或生产容量验收 |

独立Agent上下文复核由`p503_session_audit`检查认证/权限和整体增量，`p503_ops_audit`检查备份/告警与扫描证据；未发现新增代码级阻塞。它们运行了真实定向测试、读取代码，但不是另一位GitHub开发者的APPROVED，也不代表生产独立安全放行。最终镜像和完整CI仍须按以下实际证据判断。

### 最终本地候选扫描

五类镜像均完成完整扫描，命令各退出 **1（发现漏洞）**，并非退出0。官方Trivy0.76.2固定digest，漏洞库更新时间2026-11-08T06:39:21Z；没有忽略文件、`ignore-unfixed`或严重性过滤。先单独下载数据库，再对本轮固定导出归档断网扫描，分析过程没有源码/秘密/Docker socket挂载。构建和容器功能检查退出0与漏洞扫描退出1分别记录。

| 镜像 | Critical / High | Medium / Low / Unknown | 有修复版本的C/H匹配 | 实际config digest前缀 |
| --- | ---: | ---: | ---: | --- |
| app | 1 / 34 | 95 / 85 / 0 | 0 | `e5f21eb98895` |
| proxy | 0 / 2 | 3 / 0 / 1 | 1 | `aa05941e9d1f` |
| tools | 4 / 75 | 207 / 174 / 1 | 26 | `171a743cac4f` |
| operations | 4 / 98 | 225 / 176 / 2 | 49 | `2314cd13feb0` |
| PostgreSQL | 4 / 75 | 204 / 174 / 1 | 26 | `107127087bab` |

全部C/H的包、CVE、安装/修复版本、原始标题/描述、URL及供应商补充说明在 [P503_IMAGE_SCAN.json](security/P503_IMAGE_SCAN.json)，包括五类完整index/manifest/config/archive摘要、原始JSON/构建日志摘要和修复前后差异。tools/operations各减少1个Critical及13个High，14项消失匹配都来自npm目录；实际镜像npm11.21.2、tar7.5.22。剩余可修匹配中，tools/PG的26项属于gosu携带的旧Go版本，operations另有Restic静态依赖；并不意味着当前官方成品已有可直接替换的兼容修复版。

app的Debian zlib Critical CVE-2023-45853有供应商“不构建受影响minizip”的依据；**不扩展到其他zlib CVE**。CVE-2026-76844原始Title误指webpack，Debian记录实际为gz_write失败后的内存错误，Bookworm仍未修复；同类CVE-2026-85091也保留。实测Node/Sharp/libvips不动态链接该Debian库，Node没有暴露gzwrite文件API，但Node内置源仍含相关旧分支，不能按内置版本较新就宣称已修复。[Debian gzwrite记录](https://security-tracker.debian.org/tracker/CVE-2026-76844)

app的35条C/H匹配对应11个不同CVE，不是35个独立缺陷。独立复核按触发条件分组：util-linux的24个High匹配中16个涉及本地受限挂载/特权路径，8个涉及libblkid解析恶意DOS分区镜像；systemd的2个匹配要求homed服务；ncurses3项、gzip1项、Perl1项分别涉及infocmp、多文件LZW→LZH、Archive::Tar特定输入；libacl1项要求高权限调用者处理可被攻击者替换的路径；另有上述zlib2项。常驻容器非root、只读、无capabilities及SYS_ADMIN、no-new-privileges、不运行homed，减少这些触发面；图片上传解码也不同于分区镜像解析。这些配置与输入条件不是对全部本地/native路径不可达的证明。

PG的libxml2仍可能通过恶意XML输入触及，SQLite依赖也未被本轮删除；不以“业务不是SQLite”代替路径审查。Caddy、gosu、Restic的进一步证据见下节。当前官方PG18.6、Caddy2.11.9、Restic0.19.1未提供本轮可直接替换的维护成品，未采用自编译镜像或删除功能包压低数字。

完整构建前/后输入指纹均为 `7dfebd22b258aae92f6d08e5a636506e1ca640a2bec453c3300b9a510042fa36`；每类构建日志、metadata、导出归档和原始报告保存在Git外 `mq-p503-final-4ef689b422ad40dbb2cc4fe394c1def3`。源码标签记录的是构建时base与dirty状态，**不能单凭标签称其已是受审main**；输入清单覆盖实际Docker上下文，并与本PR最终文件核对。扫描ImageID匹配实际config digest，不混用Docker29可能返回的index ID或归档SHA。未来从获审main重新生成正式候选时，若digest变化，必须对新候选重扫，不能沿用本地标签结论。

复跑入口为 `node scripts/production/image-security-scan.mjs --output=<新的Git外绝对目录> --app=<固定镜像> --proxy=<固定镜像> --tools=<固定镜像> --operations=<固定镜像>`；PG默认使用Compose锁定的官方镜像。工具拒绝覆盖旧报告、缺少任一镜像、摘要错配或扫描中源码变化；失败退出2并保留阶段。已知漏洞退出1不会改写为成功，也未被接入功能CI冒充“扫描全绿”。

### Go静态二进制的补充证据

官方govulncheck1.9.0、Go1.27.3、2026-11-05漏洞库，对实际gosu/Caddy/Restic二进制进行分析。文本扫描均退出3（发现漏洞）；JSON模式退出0只表示生成机器结果，不是无漏洞。完整JSON、文本、二进制SHA及退出记录保存在Git外 `mq-p503-callpaths-15b1bd80bc454621843ce6caf164cc95`。

- gosu1.19：26项旧Go High版本匹配没有找到受影响调用符号，但找到`moby/sys/user`的本地passwd/group无界解析（GO-2026-6686 / CVE-2026-61801）。容器不挂入外部passwd/group，非root运行和只读根减少攻击面；这不是整个gosu无漏洞证明。官方PG尚未更新该二进制，不擅自替换。
- Caddy2.11.9：4项symbol-level，包括HTML解析/渲染、压缩帧和openpgp通配符。项目没有ACME server或templates处理器，已补配置断言，admin API关闭；这些限制不能替代全部调用可达性证明。`apk upgrade`不能更新静态Go依赖，不改用自编译二进制来掩盖问题。
- Restic0.19.1：38项symbol-level，包含HTTP/TLS/XML等实际S3读写相关包；不能因它按需运行就宣称不可利用。仅连接批准的TLS后端、隔离备份身份与密码、拒绝任意仓库URL是缓解，仍等待维护版或单独验证的升级路径。

上述数字与Trivy包/CVE匹配口径不同。govulncheck二进制模式不能提供运行时可达性的完整证明；最终Trivy结果继续保留所有匹配，不据此添加忽略表。[gosu上游安全说明](https://github.com/tianon/gosu/blob/1.20/SECURITY.md)、[Go分析工具](https://go.dev/doc/tutorial/govulncheck)

### P5-03本地回归

| 命令/检查 | 实际结果 |
| --- | --- |
| `npm run check` | 最后修复后退出0；343项，337通过/6项既有Linux专属用例在Windows跳过，lint/Schema/typecheck/build均通过 |
| `test:production:db` / `test:production:rotation` | 均退出0；PG18.6、001–008、五类身份、11个owner、权限漂移拒绝，6组真实SCRAM/会话/签名轮换 |
| `test:auth:session-spike` | 16组真实PG/HTTP对照，退出0；含风险仍存在的负面反例 |
| `test:auth` / `test:admin` | 均退出0；认证35 HTTP+8 HTTPS，管理员18 DB+20 HTTP+4 HTTPS |
| `test:media:upload` / `test:public` | 均退出0；媒体权限6+恢复竞争2+组合权限3+HTTP17+HTTPS5；公开15+分享10 |
| `test:production:release` | 修正receipt DTO后完整退出0；新镜像下真实S3模拟、备份8.991秒/恢复3.843秒、轮换、图片/故事权限、桌面手机浏览器、失败闭入口和兼容回退；错误仓库回执负控通过 |
| `test:production:bootstrap` | 新镜像下退出0；独立production合同空库及真实业务/HTTPS/浏览器，另一集群恢复29.262秒，旧Session/业务密钥失效，同镜像升级/回退及8GiB拒写 |
| `test:backup:oss` | 退出0；Restic0.19.1、虚拟主机/TLS/香港签名scope、96次本地请求，真实加密check/restore；未访问真实OSS |
| 告警HTTPS测试 | 24/24退出0；测试消息503/响应丢失仅一次请求；另外一条经授权真实消息已由负责人确认收到 |
| npm审计 | `--omit=dev`退出0、0告警；完整审计退出1、10个开发链Moderate，源于minimatch，未强制override或隐藏 |

Windows宿主仍为Node24.19.0/npm11.17.0；新候选镜像使用Node24.22.2/npm11.21.2。上述容器恢复时长是本机小型合成样本，不是VPS RTO保证。短时测试CA确实触发证书临期告警，监控保留`ok=false`，没有修改生产阈值。完整Linux最终提交CI另外记录于PR，不能拿main上一轮的绿色结果代替本轮。

### 生产决定尚未作出

1. Session存储：负责人须在独立安全审查后明确接受有期限的现状风险，或先另行实施完整会话存储/句柄整改。本轮没有作出接受决定。
2. 镜像：可修复项优先使用官方兼容更新；没有官方修复或仍有可达疑问的Critical/High，不由Agent自动接受。维护容器的高权限和TLS客户端路径同样纳入审查。
3. 运维：正式OSS前缀与锁限定RAM策略尚未应用，原凭据仍较宽；保留策略仅dry-run，VPS外部探针和生产timer未配置。单条飞书送达不代表真实故障自动发现与告警闭环。
4. 部署：本轮只读VPS，不改现有合成服务。正式密钥、独立空库、管理员初始化、主机Node更新、峰值容量、公共TLS及80/443均需后续精确批准与验收。详见 [上线顺序](PRODUCTION_LAUNCH.md)。

本轮保留三类失败记录：官方Debian仓库返回HTTP502使首次构建退出1，原输入重试通过；公开接口测试短暂创建合成图片，构建来源指纹变化时主动停止，改为测试结束后串行冻结构建；新异地回执负控在真实release演练中发现测试DTO漏掉backend/repositoryId，补齐真实回执的两个非秘密字段并提前断言。没有关闭APT签名、来源指纹或仓库身份检查。中间构建/扫描不作为最终候选，失败实验目录和日志均留在Git外。

## P5-02历史扫描（下列digest不代表P5-03候选）

2026-11-07。本轮修复了应用镜像中可更新的系统包，并移除运行时不需要的包管理器；**没有完成生产安全放行**。下列扫描和本地测试不能替代独立 Review、真实部署验收或对剩余风险的明确处置。没有修改 VPS 镜像、开放公网端口或生成正式凭据。

## 扫描方法与结果

使用官方 [Trivy 0.76.2](https://github.com/aquasecurity/trivy/releases/tag/v0.76.2)，linux/amd64 镜像固定为 `ghcr.io/aquasecurity/trivy@sha256:6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6`。漏洞库更新时间 `2026-11-07T06:54:25Z`，下载时间 `09:14:59Z`。

先在没有项目文件或秘密挂载的容器下载官方数据库，再对本地 `docker image save` 归档断网扫描。扫描容器使用非 root、只读根目录、`--cap-drop ALL`、`--network none`，没有 Docker socket；归档只读，结果和缓存位于本轮独立目录/卷。不使用 Docker Scout，不上传源码、SBOM 或完整报告，关闭遥测。首次数据库下载因指定的 128 MiB 临时空间不足退出 1；扩大本机扫描容器临时空间后下载成功，没有改变 VPS 磁盘门槛。

实际扫描参数为：

```sh
trivy image --input /archives/IMAGE.tar --cache-dir /cache \
  --scanners vuln --skip-db-update --skip-java-db-update --offline-scan \
  --disable-telemetry --parallel 1 --timeout 10m --no-progress \
  --format json --output /reports/IMAGE.json --exit-code 1
```

所有镜像均成功生成完整 JSON，扫描命令均因发现漏洞退出 **1**。没有 `ignore-unfixed`、CVE 忽略表或仅输出低风险结果的过滤。下表是原始包/CVE 匹配数，不是可远程利用入口数；一个 CVE 可能匹配多个包。

| 本地镜像 / 用途 | 修改前 Critical / High | 修改后 Critical / High | 修改后 Medium / Low / Unknown | 有修复版本的 High/Critical 匹配数 |
| --- | ---: | ---: | ---: | ---: |
| app，常驻应用 | 5 / 57 | 1 / 34 | 98 / 82 / 0 | 0 |
| proxy，常驻入口 | 0 / 2 | 0 / 2 | 3 / 0 / 1 | 1 |
| tools，按需迁移/维护 | 5 / 88 | 5 / 88 | 228 / 174 / 1 | 40 |
| operations，按需备份/恢复 | 5 / 111 | 5 / 111 | 246 / 176 / 2 | 63 |
| PostgreSQL，常驻数据库，未修改 | 4 / 75 | 4 / 75 | 207 / 171 / 1 | 26 |

PostgreSQL 单独扫描了 Compose 实际固定的官方 `postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5`，没有用 tools 的结果代替数据库镜像。查询时该 tag 仍指向同一 index；linux/amd64 manifest 为 `02fb3245e038f33536cf13bc6c4e59f21d07b0cea3c1fe1c07c6e8aa8f083bcc`。

## 已完成的修复

Dockerfile 在固定基础镜像和同一发行版的官方签名仓库内更新 Debian 包，proxy 更新 Alpine 包；没有跨发行版升级。APT 首次更新显式使用 `Acquire::Retries=0`，避免旧 APT 下载重试路径的已知校验问题。[Debian APT 公告](https://security-tracker.debian.org/tracker/CVE-2026-109518)

本轮受扫 app 容器只读核验退出 0：Node 仍为 `v24.19.0`；`apt/libapt-pkg6.0=2.6.2`、`libpcre2-8-0=10.42-1+deb12u2`、`perl-base=5.36.0-7+deb12u4`。npm、npx、corepack、yarn、yarnpkg 均不存在。它们只从应用最终层移除，构建和维护工具继续保留需要的依赖。app 的 Node 包漏洞匹配数从基镜像 npm 带入的多项降为 0；不能把该结果扩展为整个 JavaScript 生态无漏洞。[PCRE2 修复](https://security-tracker.debian.org/tracker/CVE-2026-103111)、[Perl 修复](https://security-tracker.debian.org/tracker/CVE-2026-13221)

## 剩余风险的处置依据

| 项目 | 已核实的依据 | 上线前仍需完成 |
| --- | --- | --- |
| app 唯一 Critical：`zlib1g` / CVE-2023-45853 | Debian 明确说明 Bookworm 的 zlib 未编译受影响的 contrib/minizip 二进制。原始扫描保留该匹配。 | 将供应商依据纳入独立审查，不能将所有 zlib 或其他 High 一并忽略。[Debian 说明](https://security-tracker.debian.org/tracker/CVE-2023-45853) |
| tools/operations/PG 的 SQLite CVE-2025-7458 | Debian Bookworm 标记 no-dsa/minor；攻击要求执行特定的任意 SQLite SQL。应用数据库为 PostgreSQL。 | 核实具体依赖路径与输入可达性；“不使用 SQLite 作为业务数据库”本身不是完整无影响证明。[Debian 说明](https://security-tracker.debian.org/tracker/CVE-2025-7458) |
| tools/operations/PG 的 libxml2 CVE-2026-6653 | Debian Bookworm postponed/minor，受影响路径处理恶意 XML，当前同发行版无修复包。 | 核查恢复工具及数据库 XML 能力的输入边界，不能把 postponed 写成已修复。[Debian 说明](https://security-tracker.debian.org/tracker/CVE-2026-6653) |
| tools/operations 的 npm 内置 `tar=7.5.16` / CVE-2026-59873 | 文件位于 `/usr/local/lib/node_modules/npm/node_modules/tar`；上游 7.5.19 修复不受限解包 DoS。锁定 npm 发行版仍包含该依赖。 | 不接收任意 tar 包或在运行时执行不受控 npm 安装；评估经回归的上游 npm 更新，不能手工替换 npm 内部依赖后宣称兼容。[node-tar 公告](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw) |
| tools/operations/PG 的 gosu / CVE-2025-68121 | 扫描定位 `/usr/local/bin/gosu`，不是 Prisma；Go 1.24.6 的 TLS 会话恢复在特定 CA 配置变化下受影响。 | 独立核实该二进制是否包含且调用受影响 TLS 路径，或等待经验证的上游重构建。版本匹配不等于已经证明可利用。[Go 公告](https://pkg.go.dev/vuln/GO-2026-4337) |
| proxy 的两个 High | `go-jose/v3=3.0.5` 的恶意 RSA JWK DoS 没有 v3 修复版；`x/net=0.60.0` 的 HTML 解析 DoS 在 0.62.0 修复。这些是静态 Caddy 二进制依赖，`apk upgrade` 无法更新。 | 对实际 Caddy 模块/配置开展调用路径审查或采用验证过的上游修复镜像；本轮没有擅自改用自编译代理。[go-jose 公告](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q)、[Go HTML 公告](https://pkg.go.dev/vuln/GO-2026-6860) |

app 剩余 34 个 High 在本次数据库中没有可用修复版本，涉及 util-linux、ncurses、systemd 相关库、gzip、ACL、zlib 等。按需维护容器也可能拥有高权限秘密；运行时间短不等于风险可忽略。没有新增第五种发布镜像、删除 PostgreSQL 功能包或修改扫描规则来压低结果。完整报告必须逐项审查，并对可达性、缓解措施和残余接受结论留下负责人/独立审查记录；目前尚未完成该放行。

## 镜像与报告追溯

以下是修复探针 Host 保留和容器模板打包后的本地候选，均在扫描前核验并按固定 Docker image/index ID 导出。四类镜像重新执行完整断网扫描，计数与上表一致、退出码仍为 1；PostgreSQL 固定镜像未变化，不重复扫描。归档 SHA-256 与 OCI config digest 是不同值；Trivy `Metadata.ImageID` 对应归档里的 config，不能拿来代替发布 manifest 校验。

| 镜像 | 本轮本地候选 ID | 导出归档 SHA-256 |
| --- | --- | --- |
| app | `435259f04049cdba38b9da1ae605df7c0f7502d0ed692437f51cffd9b46c51c0` | `53169de0318c478172b6254dc41b5fe1eb8a8b45604bca3aa3ffdd0475777bdb` |
| tools | `023c0f608ca1cb5974e26ab94d53d336e20bba06a06372250e8b7a9c71b2e34f` | `6fb51055ef93a80d292c18f034493e3ec8a96fc1a5f0b5e4bc1703abdba3d759` |
| operations | `7607f6c43f85794f504bab32fc22e7bc0c40d8144a44a727f74725dad6e4c2a2` | `e39985cf87604dab7da845239b6fa6e65655ac87691f82af37fc911337e16427` |
| proxy | `524bcb85b0dd312c3481339c1a3110fac54d122dbb6102ac176fd27032056ecd` | `123dd9b927e7240a3a0fa5da8ac3bc752126d0a5b4ba685831947497046472da` |
| PostgreSQL | `f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5` | `1348aa1d3fa3211ce5650b0b7d33046effa1690eab667b36981816fb21464769` |

完整 JSON、原始扫描退出码和镜像清单保留在开发机 Git 外的 `mq-p502-image-scan-11b8ad1b293347d7ad0ef6b82b5b8327` 实验目录；最新报告使用 `*-postpackaging.json`，此前 baseline/`*-final.json` 记录保留。首次下载空间不足的失败保留在本轮工具记录。扫描专用缓存卷也保留，未清理未知 Docker 资源。本轮结果不是对未来重新构建的任意镜像背书；正式候选仍须绑定具体 digest 并复核。

锁定 npm 依赖另行执行 `npm audit --omit=dev`，退出0、运行依赖0条已知告警；完整 `npm audit` 仍有10个 moderate 依赖链匹配，来自开发工具的 minimatch 公告。当前 ESLint 要求10.x，已修复的11.x包含移除API等不兼容变化，未通过强制override掩盖风险。只使用仓库固定lint规则，不接受外部任意glob；仍需兼容上游升级及回归。[minimatch公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)

## 其他不能被镜像扫描替代的门槛

- Better Auth Session Token 仍原值存库。官方扩展点和哈希实验结果见 [Session Spike](../archive/SESSION_TOKEN_SPIKE.md)；不因镜像漏洞减少而接受数据库/备份泄露风险。
- 管理员维护、发布签名和留言审核仍必须满足数据库权限、有效 Session、事务和独立密钥约束。恢复后失效旧会话/秘密的流程不能省略。
- 同机加密备份不是异地副本；OSS香港私有Standard/ZRS已完成小型合成数据的真实上传、全量检查和隔离恢复。正式生产数据备份、VPS定时任务和真实告警送达仍未验证。见 [异地备份与告警](OFFSITE_BACKUP_AND_ALERTS.md)。
- 公网 TLS/代理、实际生产配置、正式密钥保管、入口限流及真实磁盘容量仍需单独验收。不得把合成环境写成已经正式上线。
- 本轮最终提交的 Quality、Database、Container CI 和独立 Review 状态以 PR 的实时记录为准；通过功能 CI 不代表上述镜像扫描退出 0，也不代表独立安全审查完成。

2026-11-08真实OSS演练补齐了tools/operations镜像的发行版系统CA证书包。上表的扫描digest对应11月7日候选，不是这次重建镜像的扫描凭证；正式发布候选仍须按最终digest重新扫描与审查。没有用此次证书修复宣称既有CVE已解决。
