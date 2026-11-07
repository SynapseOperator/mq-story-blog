# P5-01：首次 VPS 隔离部署

关联 Issue #57。目标是验证真实主机上的单套合成 staging，不能用于接管已有数据库或开放生产。公网 80/443、正式业务开关和生产 apply 均不在本轮授权中。

## 发布来源与首次初始化

先按普通 merge 保留 #54 → #56 的祖先关系，每次等待 main 的 quality/database/container 成功。候选工作流从最终 main 手动运行，构建前后核验合并、精确提交 Review、未解决讨论及 CI。主机不保存 GitHub 凭据，也不构建 Next.js。

下载的信任链是：已认证 GitHub API 的 artifact digest → 原始 ZIP → release.json → 四个 OCI 的归档、index、manifest、config 和 blob。未知下载中的 checksum 不能作为信任根。传输后在 VPS 再次验证每个文件大小/摘要及整个候选；通过后才允许 Docker load，并核对加载后的 descriptor digest。

原有更新工具要求真实 currentRelease 和备份回执，不能用假记录初始化空库。新增 `scripts/production/vps-bootstrap.mjs` 只接受全新的 `/srv/mq-labs/p501-<UUID>`，执行现有 bootstrap → migrate → provision → keys → runtime audit → media/admin 合成初始化。失败关闭本实验 app/proxy，保留卷和状态，不 reset、不自动降级。

```sh
/opt/mq/node-v24.19.0/bin/node scripts/production/vps-bootstrap.mjs \
  /private/candidate TRUSTED_RELEASE_JSON_SHA256 \
  /srv/mq-labs/p501-UUID 18080 18443
```

运维 Node 仅从官方签名验证过的固定发行包安装 `bin/node` 与 LICENSE，位于独立版本目录；不安装 npm 开发依赖，不替换系统 Node。应用仍使用候选镜像内的运行时。

## 主机边界

- 新目录 root:root 0700，实验状态含秘密，必须保持 0600；不复制到 Git、Actions Artifact 或诊断日志。
- 随机 staging 数据库及五类登录身份、11 个 NOLOGIN 函数 owner，沿用 001–008；应用使用低权限 runtime。
- 独立 Compose project/network/volume，Caddy 仅绑定 `127.0.0.1:18080/18443`。app/PostgreSQL 没有 host port；SSH/UFW/NTP 不变。
- 经 SSH tunnel 使用 `https://mq.localhost:18443`。HTTP 验收校验实验 CA；浏览器证书例外只限本实验 context，不能据此声称公网证书已验收。
- 保持现有 app 1536MiB/2CPU、PostgreSQL 768MiB/1CPU、proxy 128MiB/0.5CPU；维护容器按需运行。主机至少保留 8GiB，媒体写入也使用同一余量门槛。
- 只生成合成账号、故事、图片和留言。实验秘密不作为正式凭据，生产初始化仍需单独授权。

## 验收与恢复

`vps-browser-checks.mjs` 在运维电脑运行，输入来自 SSH 的私有 fixture，分 before / after-recreate / after-restore 三阶段。测试状态和 Cookie 留在同一受限目录；首次初始化不覆盖既有 checkpoint，未知结果不得盲目重复写入。若业务 HTTP 已完整通过、仅浏览器失败，可显式使用 `resume-browser`：复用检查点，不重放注册、上传或故事/留言写入；浏览器登录仍会建立合成 Session。

`vps-phase.mjs faults` 执行本项目 app 异常退出、断库、错误配置、真实低容量 tmpfs 和容器重建；不填满主机、不触及其他容器。

`vps-phase.mjs restore` 停止本实验写入后，使用现有 Restic 和数据库/媒体一致性机制备份，再恢复到新数据库与新媒体卷。恢复清除旧 Session 和业务签名授权，验证数据库约束、运行权限及图文后启动恢复目标；发布和留言写入仍关闭。源库和原卷保留，不自动切回旧目标。

恢复首次开始先记录独占标记；中断后需要人工检查，不能覆盖备份密码或把重试误当作新恢复。备份位于同一 VPS 只是本轮演练，不是异地灾备。

## 清理与正式上线

成功后本实验继续保留，停止时仅使用回执记录的 project/Compose 文件关闭 app/proxy。不得使用全局 prune、删除未知卷或不加目标检查的递归清理。Node 回退仅移除本次独立版本目录，且需先确认没有本轮进程在使用。

正式上线仍需要独立审核新协调代码、生产主机执行路径、正式秘密托管及管理员初始化、域名 HTTPS/Origin/Cookie、异地备份与送达告警、容量压力及恢复演练。Better Auth Session Token 仍原值存库；合成部署成功不代替独立安全审查。

## 发布候选证据（2026-11-07）

| 项目 | 实际结果 |
| --- | --- |
| #54 普通 merge | `0fcd1e6f5b1ec27a986de887f06249ca063a8e6c`；[main CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42344702054) 三项成功 |
| #56 调整 base 后普通 merge | `72e36cb82d2a5ea9191fec362dc4ab41a42655e1`；[main CI](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42346575638) 三项成功 |
| 精确提交审批 | #54 `50e4db9`、#56 `eef9b48` 均核对独立 APPROVED、零未解决线程；调整 #56 base 未改变 HEAD |
| 发布候选 | [手动工作流 42348238944](https://github.com/SynapseOperator/mq-story-blog/actions/runs/42348238944)，来源为上述最终 main；构建前后门禁均成功 |
| 原始 Artifact ZIP SHA-256 | `38f983e4c1212ef4773232c800d98f7af18356b6d07ad7f28b84462aa5cef692`，与 GitHub API 一致 |
| release.json SHA-256 | `9cb5cd6908f450dc34c894646b917e9fe9995131f96629f7847e4faa8df1c6c5` |
| 本机 OCI 验证 | 四类归档完整验证，退出 0；归档摘要不等同于 OCI index / manifest / config digest |
| 运维 Node 来源 | Node 官方 24.19.0 linux-x64，官方 release key 的 detached/armored 签名及归档、二进制摘要校验均退出 0 |

首次下载在部分 ZIP 处中断，保留失败记录后通过已认证下载的范围续传完成；没有关闭 TLS 校验。#56 历史临时 base 过滤在本次新分支中移除，未改动已审批 PR 的 HEAD。

## 真实 VPS 初始化结果

2026-11-07 07:21 UTC，bootstrap 退出 0，随后独立运行信息检查退出 0。目标为 `/srv/mq-labs/p501-4335940c-9793-46a9-9da8-66bd638156e9`，应用来源为上述已审核 main。

| 项目 | 实测 |
| --- | --- |
| 主机运维 Node / 应用 Node | 24.19.0 / 24.19.0 |
| Docker / Compose | 29.9.3 / 5.7.0 |
| Next.js / PostgreSQL / Caddy | 16.4.2 / 18.6 / 2.11.9 |
| 应用 UID | 10001 |
| app / PostgreSQL / proxy 上限 | 1536 / 768 / 128 MiB；2 / 1 / 0.5 CPU |
| 初始化后磁盘可用 / 空闲 inode | 33,683,542,016 字节 / 4,935,219 |
| 物理内存 / 当时可用 / Swap | 4,105,363,456 / 3,293,302,784 / 0 字节 |
| 入口 | Caddy loopback 18080/18443；app/PostgreSQL 无宿主发布端口；实验 CA 验证的 HTTPS `/api/stories` 返回 200 |
| 数据库 | 空库 001–008、五类身份、11 个函数 owner、运行权限 audit、媒体初始化及合成管理员初始化均通过 |

镜像在 VPS 再次按 OCI descriptor digest 核对，未运行源码构建。上述资源值是初始化时点证据，不是压力测试。

首次 `vps-browser-checks.mjs before` 退出 0，实际请求经 SSH tunnel 到该 VPS：

- 空库和游客权限、注册登录、数据库 Session 与 Origin 边界。
- 两张合成图片上传、私有读取、尺寸及 SHA-256 校验。
- STAR/CAMPFIRE 发布、已发布故事新草稿隔离、公开图文和分享 HTML/RSC/metadata 隔离。
- 点赞持久化与重复请求、匿名/账号留言和审核；下架后拒绝、恢复后保留原公开版本。
- 1536×1024、390×844、320×568，触屏及 reduced-motion；首页、羽毛信、编辑器、嵌套登录及留言草稿保护。9 张 PNG 以 DPR 2 输出，布局仍按 CSS 视口验收。

Browser 插件不可用，沿用项目 Playwright。图片、账号、故事及留言全部为合成数据；测试 Cookie 和账号 fixture 仅留在受限本机目录，不进入 Git 或 CI Artifact。

首次故障验收退出 1：应用异常退出、数据库断连、错误配置、8 MiB tmpfs 低容量拒写四项均通过，后续容器重建阶段失败。原脚本未保存细分失败码，因此无法严格还原第一次失败的根因。之后的定点重建中，三个容器 ID 均改变，原卷保留，HTTPS 返回 200；`after-recreate` HTTP 与三尺寸浏览器检查退出 0，确认故事、图片哈希、点赞、留言和原 Session 保留。

核查发现 Caddy 没有 healthcheck，Compose `--wait` 只保证其进程 running，原维护脚本随即单次 HTTPS 存在就绪等待缺口。补充只读、有限时的 HTTPS 探测：最终必须证书校验成功且返回 200；仅临时连接错误和 502/503 可重试，证书错误直接失败。数据库停机要求 503 的检查仍为单次。另加脱敏阶段/状态码记录，失败仍关闭本实验 app/proxy，不把重试或本地测试当成首次故障已被证明的根因。

2026-11-07 07:58 UTC，完整故障重跑与恢复退出 0：

| 真实 VPS 验收 | 结果 |
| --- | --- |
| 异常退出 / 断库 / 配置拒绝 / 低容量 / 容器重建 | 五项通过；原数据库与卷未清空 |
| HTTPS 启动窗口 | 本次重建首次探测记录 `ECONNRESET`，随后正确 CA 验证的 200 通过；未放宽成功条件 |
| Restic 数据库与媒体联合加密备份 | 4,986 ms；完整性回执验证成功；重复初始化/覆盖拒绝 |
| 新数据库与新媒体卷恢复 | 2,175 ms；从恢复开始至 HTTPS 可访问共 11,880 ms |
| 恢复权限 | 用户/故事/媒体/约束保留，低权限审计通过，旧 Session 与数据库业务签名授权清空 |
| 恢复入口 | 使用同一个 loopback Caddy；发布和留言写入关闭；源数据库和原卷保留 |
| 主机安全复核 | UFW active、默认拒绝入站；敏感端口无非回环 TCP 监听；NTP synchronized；AppArmor enabled/active |
| 最终磁盘与 inode | 可用 33,659,265,024 字节、空闲 inode 4,934,482 / 5,111,808 |

资源监测从初始化至恢复完成，共 644 个采样点：主机 CPU 采样峰值 36.48%，最低 MemAvailable 3,099,754,496 字节，最低可用磁盘 33,655,349,248 字节。app / PostgreSQL / Caddy 容器内存采样峰值分别为 303,248,179 / 112,826,777 / 15,225,323 字节。这不是连续峰值捕获、负载容量或真实业务 RTO 承诺；备份仅含小规模合成数据，且存于同一 VPS。

Docker 的入口隔离同时按 Compose 配置和实际 app/PostgreSQL PortBindings 验证，不能仅凭 UFW/`ss` 结论推断云安全组或全部公网网络行为。本轮未修改云安全组、SSH、UFW 或 NTP，未开启公网 80/443。

恢复后的 `vps-browser-checks.mjs after-restore` 退出 0：旧管理员 Cookie 返回 401、旧读者会话不再识别；新管理员登录和私有图片读取正常；公开故事、图片哈希、点赞与已审核留言保留；私有图片仍为 404；发布/留言写入为 503；注销后的 Cookie 立即失效。桌面、390px、320px 浏览器与 reduced-motion 均通过，无 pageerror/console error，并另外生成 9 张 DPR 2 截图。

| 本轮命令 | 退出码与范围 |
| --- | --- |
| `npm run check` | 0；lint、schema、typecheck、294 项测试（289 通过、5 项既有平台跳过）、生产构建 |
| 四个 VPS 定向测试文件 | 0；21 项通过，无跳过，含真实本机 HTTPS 延迟启动、持续失败及证书拒绝测试 |
| `vps-bootstrap.mjs` | 0；真实 VPS 空库初始化与权限、HTTPS 验证 |
| `vps-phase.mjs faults` | 首次 1，保留记录；补齐就绪检查后的完整重跑 0 |
| `vps-phase.mjs restore` | 0；真实 VPS 加密备份、新目标恢复与权限核验 |
| `vps-browser-checks.mjs before / after-recreate / after-restore` | 各 0；真实 VPS HTTPS 与生产构建浏览器 |
| 最终主机只读检查 | 0；UFW、端口、NTP、AppArmor、内存与磁盘 |

协调脚本由本功能分支提供，应用及离线工具使用已审核 main 的候选镜像；本功能分支仍需独立 Review。最终分支的全套 quality/database/container 结果见 PR Checks，不能以此前 main 的 CI 代替。
