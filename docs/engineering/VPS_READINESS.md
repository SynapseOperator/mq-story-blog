# P4-02：真实 VPS 只读验收

关联 Issue #55。P4-02 基于尚未合并的 PR #54（`50e4db9`），不改变其审批状态。本轮只通过已有 SSH 别名执行原生命令，没有安装软件、修改 SSH/防火墙、初始化数据库或部署网站。

## 实际结果

本机在 **2026-11-07 03:41:44 UTC** 收到严格校验后的报告，SSH 退出 **0**；预检退出 **1**，表示存在部署阻塞，不是连接失败。VPS 自报时间为 **2026-11-06 19:27:53 UTC**，两条 UTC 记录相差约 8 小时 14 分钟，且 `NTPSynchronized=false`。记录包含采集和传输时延，不是同步校时测量，准确钟差及原因待复核。远端时间暂不能作为可信审计时间；Asia/Shanghai 时区本身不应造成 UTC 偏差。

| 检查 | 实测 | 判断 |
| --- | --- | --- |
| 系统/架构 | Ubuntu 24.04 / x86_64 | 支持现有 linux/amd64 候选 |
| CPU / load 1、5、15 分钟 | 4 vCPU / 0.05、0.01、0.00 | 本次空载采样通过；不是性能压测 |
| 内存 | 总 4,105,375,744 B（3.82 GiB）；可用 3,674,353,664 B（3.42 GiB） | 满足当前硬件门槛 |
| Swap | 0 | 警告；不得用 Swap 替代内存或自动创建 |
| 根文件系统 | 总 40,483,942,400 B（37.70 GiB）；可用 38,522,277,888 B（35.88 GiB） | 当前超过 8 GiB 余量；未证明应用增长及备份峰值可用 |
| inode | 总 5,111,808；可用 5,026,345（98.33%） | 通过 |
| 时间 | Asia/Shanghai；NTP 未同步，UTC 明显偏差 | **上线阻塞**；影响 TLS、Session、签名及备份新鲜度 |
| SSH | ssh.service active；ssh.socket active/enabled；TCP22 非回环监听 | 已成功密钥连接；socket activation 生效，未验证来源限制 |
| SSH 有效策略 | 全局、当前连接和 root Match 检查均无有效结果 | **未验证**；非交互提权未取得结果，不能推断已禁用密码/root |
| UFW | 未取得状态 | **未验证**；不能写成 inactive 或安全 |
| AppArmor | 内核 enabled；服务 active | 已启用；尚未验证未来容器 profile |
| 网络 | 非回环 IPv4 存在；未发现非回环 IPv6，包括 global IPv6 | 不配置 AAAA；公网路由、IPv6 能力和安全组未验证 |
| 监听 | TCP22 非回环；TCP/UDP53 仅回环 | 本次未发现 80/443/3000/5432/2019/2375/2376 监听；不代替外部扫描 |
| Docker / Compose / Node | 版本探针均无有效结果 | 可用性**未验证**，不将权限不足与未安装混为一谈；未为预检安装 Node |

此前负责人已完成旧 root 密码轮换、mqops 公钥配置、两会话登录和指纹核对；这是交接事实。本轮另实测一次只读 SSH 成功，不再次声称密码尚未轮换。私钥和密码未读取到报告、Git 或日志。此前连接失败记录保留，最后一次成功不抹去失败；远端断连原因未确定，不归因于服务端配置或密钥错误。

硬件适合继续验证**单套** MQ。保持 app 1536 MiB、PG 768 MiB、Caddy 128 MiB，总上限 2432 MiB；不同时常驻 staging 与 production，不在 VPS 构建 Next.js。当前负载低不代表规格浪费，也不能据此降低内存或数据库安全阈值。实机容器峰值、上传/密码哈希并发、磁盘导入与备份负载仍待验收。详见 [资源与部署差距](VPS_DEPLOYMENT_GAPS.md)。

## 采集与结果边界

`scripts/production/host-preflight-native.sh` 使用 POSIX sh 与 Ubuntu 原生命令，从 SSH stdin 执行，不上传远端脚本。默认不提权；显式 `--sudo-read` 仅对固定只读检查使用 `sudo -n`，不会请求或记录 sudo 密码，也不改 sudoers。权限或命令不足保留 unknown。

地址仅在远端内存用于 `sshd -T -C` 的 Match 上下文；输出只保留端口范围、布尔值和容量。默认 SSH 值、当前连接和 root Match 分开，不能相互代替。采集端每个外部探针超时 6 秒，本地 `host-preflight-import.mjs` 拒绝额外字段、地址、重复项或原始 banner，只输出脱敏 JSON。Node 仅在运维电脑解析，不要求远端安装。

Linux 运维终端可在已核对指纹的连接上运行（不保存原始输出）：

```sh
ssh -T -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
  -o StrictHostKeyChecking=yes mq-story-vps 'sh -s -- --sudo-read' \
  < scripts/production/host-preflight-native.sh \
  | node scripts/production/host-preflight-import.mjs
```

需同时检查 SSH 和 importer 两个退出码，不能只看管道最后一步。Windows PowerShell 传递字符串时可能追加 CRLF；本次本地交互助手使用固定远端 `tr -d '\r' | sh -s -- --sudo-read` 规范换行，分别检查两个退出码。OpenSSH 保护密码仅在本机可见控制台输入，未启用 ssh-agent 服务或密码认证。报告保存在 Git 外，仓库仅记录上表必要结果。

原有预检门槛不变；导入器另外给出 hardware 结果，避免把缺少宿主 Node 误称为硬件不足。Node 24 是现有部署/备份协调器的后续安装或封装选择，**不是执行只读采集的前提**。

## 下一次真实操作：需负责人批准

以下是待执行方案，本轮未应用。先补齐具有权限的只读证据，再批准相应变更；不把未知配置当作可以覆盖的默认值。

| 顺序与动作 | 精确边界及验收 | 风险与回退 |
| --- | --- | --- |
| 1. 补充特权只读检查 | 本地受控 sudo 认证；只读 UFW 规则、`sshd -t`、`sshd -T -C`、Include/Match 顺序、ssh.socket 的实际监听；核对 Docker CLI/daemon 是否存在。云安全组由控制台核实。 | 不在聊天输入密码，不输出整份配置/密钥路径；检查失败保留 unknown。 |
| 2. 修复时间同步 | 识别当前 timesyncd/chrony 状态与配置，确认无其他 NTP 服务后，批准启用/修复现有服务。验证 UTC 与可信外部时间及 `NTPSynchronized=yes`。不为修复 UTC 漂移改时区。 | 时间跳变影响审计；当前尚未运行业务，优先在部署前完成。仅回退实际修改的服务/配置；无准确时间继续拒绝上线。 |
| 3. SSH 认证加固 | 保留现有会话/VNC，再复验第二公钥会话。目标五项见下方；保留22及当前 socket activation。修改前备份精确文件，校验语法和实际 mqops/root Match，reload 后建立新会话。 | 登录失联风险；旧会话/VNC恢复本次精确配置，`sshd -t` 后 reload。不能先关闭旧会话，也不重置整个 sshd_config。 |
| 4. 云/主机防火墙 | 先选 SSH 管理 CIDR 或 VPN，再保留22对应来源规则、确认 VNC，最后限制其他入站。若动态 IP，先明确接受公钥22临时开放的风险，不猜家庭地址。80/443此轮不开。 | 误限来源会失联；现有会话/VNC撤销本次规则。云与主机规则需双重验证。IPv6如启用必须同等限制。 |
| 5. 更新与运行组件 | 先列可更新包及重启需求，批准窗口后执行。Docker/Compose 仅官方来源；安装前确认是否已有daemon、数据和存储后端；Node协调器方案另定。 | 重启/服务变化；保留控制台和精确包版本。不能自动切存储驱动、卸载未知组件或删旧数据。 |
| 6. 容量和合成演练 | 评估经批准创建1–2GiB Swap的实际收益/磁盘成本；加载已核验OCI，单套隔离合成环境测峰值、重建、低磁盘拒写、备份恢复及权限。 | Swap不保证无OOM；真实创建及移除另行授权，不能在高内存压力下直接 swapoff。演练不开放公网或正式业务。 |

SSH 目标片段（只是评审材料，不是本轮执行命令）：

```text
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

OpenSSH 多数选项采用首个匹配值；不能随意追加 `99-mq.conf` 以为覆盖 `50-cloud-init.conf`。仅在确认 Include 次序及现有文件后选择不存在的前置片段，不能覆盖同名用户文件。`Match` 可能改变连接结果，必须用真实来源的 `-T -C` 验收，不只运行全局 `-T`。

Ubuntu 24.04 的 SSH socket generator 可读取 Port/ListenAddress；本轮不需要改端口、socket或激活模式。只修改认证策略时先检查服务实际状态，再选择受支持的 reload；若未来调整监听，必须另核对 generator、daemon-reload、socket/service及重连顺序，不能只 restart ssh.service 就认定生效。[Ubuntu socket activation](https://discourse.ubuntu.com/t/sshd-now-uses-socket-based-activation-ubuntu-22-10-and-later/30189/1)、[OpenSSH 配置](https://ubuntu.com/server/docs/how-to/security/openssh-server/)

Docker 发布端口经 NAT/转发路径，可能绕过 UFW INPUT。保持现有 Compose 仅 Caddy 映射80/443，数据库和应用不发布；未来必须从获准的外部IPv4/IPv6来源实测。不要关闭 Docker 防火墙，也不要把 iptables-nft 兼容模式与 Docker 原生 nftables 后端混为一谈；后者为实验能力且没有 DOCKER-USER 链，不在本轮切换。[Docker 防火墙](https://docs.docker.com/engine/network/packet-filtering-firewalls/)、[nftables 边界](https://docs.docker.com/engine/network/firewall-nftables/)

## 本轮验证

- `npm run check`：退出0，lint、Schema、typecheck、生产构建成功；273项单元测试，268通过、5项平台条件跳过。Linux条件用例由CI实际运行，未删除测试。
- `node --test tests/production-host-native.test.mjs`：Windows 7通过/1 Linux专用跳过；Linux非root、只读、无外网operations容器8通过/0跳过，退出0。
- 原生预检、既有预检及模拟HTTPS告警联合运行：Linux容器29项全部通过，退出0。Windows原生预检与发布门禁联合运行17项，16通过/1 Linux专用跳过，退出0；production apply 拒绝及旧SHA审批不能放行仍通过。
- `node scripts/production/ssh-hardening-tests.mjs`：Ubuntu24.04隔离容器验证首值/Include、五项认证目标、Match覆盖和非法配置拒绝，退出0。合成OpenSSH包版本 `1:9.6p1-3ubuntu13.20`；没有启动sshd、测试真实socket重载或修改宿主配置。
- 真实SSH只读采集退出0；评估退出1，保留时间及软件/权限证据缺口。
- 最终 quality/database/container 仍须以本PR最终提交的真实Actions结果为准；历史或本地通过不代替最终CI。

下一步先批准主机加固/组件安装的具体范围，再安排实机合成演练。域名仍需核实注册商状态、异地备份与告警需选定；见 [外部服务准备](VPS_EXTERNAL_SERVICES.md)。正式密钥、生产执行器、管理员和公开入口均未启用。
