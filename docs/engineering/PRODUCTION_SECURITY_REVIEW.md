# P5-02：生产候选安全审查

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

- Better Auth Session Token 仍原值存库。官方扩展点和哈希实验结果见 [Session Spike](SESSION_TOKEN_SPIKE.md)；不因镜像漏洞减少而接受数据库/备份泄露风险。
- 管理员维护、发布签名和留言审核仍必须满足数据库权限、有效 Session、事务和独立密钥约束。恢复后失效旧会话/秘密的流程不能省略。
- 同机加密备份不是异地副本；R2 尚未开通，真实云端恢复及告警送达未验证。见 [异地备份与告警](OFFSITE_BACKUP_AND_ALERTS.md)。
- 公网 TLS/代理、实际生产配置、正式密钥保管、入口限流及真实磁盘容量仍需单独验收。不得把合成环境写成已经正式上线。
- 本轮最终提交的 Quality、Database、Container CI 和独立 Review 状态以 PR 的实时记录为准；通过功能 CI 不代表上述镜像扫描退出 0，也不代表独立安全审查完成。
