# P3-03：单机运维与上线前检查

关联 Issue #51，基于尚未合并的 PR #50。没有真实 VPS、域名、生产密钥或上线记录。本手册中的主机步骤尚未在目标 VPS 执行；本地容器证据不能替代这些步骤。备份与轮换的实际合同分别见 [PRODUCTION_BACKUP.md](PRODUCTION_BACKUP.md)、[SECRET_ROTATION.md](SECRET_ROTATION.md)。

## 主机、网络和账号

首版继续采用 Ubuntu 24.04 LTS、约 4 vCPU / 4GB / 40GB、Docker Compose。两个月 VPS 预算上限人民币 100 元，域名另计；未选购供应商，也未证明这个价格可获得指定配置或良好的大陆线路。采购前检查税费、续费价、流量/端口/快照费用、CPU 架构、磁盘是否独享，先从实际访问地区测试晚高峰延迟与丢包。香港地理位置不是线路质量保证。不要在 4GB 主机同时常驻两套环境，镜像在 CI 构建。

首次登录保留供应商控制台和当前 SSH 会话。由负责人指定管理来源 IP/VPN 和 SSH 公钥；创建独立 sudo 运维账号，验证第二个终端能够密钥登录后，才在 `/etc/ssh/sshd_config.d/` 设置 `PermitRootLogin no`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no`。先 `sshd -t`，再 reload，确认新连接成功后再退出旧连接。不要远程盲目启用防火墙或禁用全部登录方式。安装安全更新并规划重启窗口，保持 AppArmor；不关闭 Docker 的网络隔离或系统保护。

入口规则应在云防火墙与主机两层核对：SSH 仅批准的管理来源，公网只允许 TCP 80/443；3000、5432、Caddy 管理 API、Docker API 不开放，IPv6 必须采用相同边界。Compose 只发布 Caddy，app/postgres 使用内部网络。**Docker 发布端口可以绕过 UFW 的普通 INPUT 规则**，不能以 `ufw status` 一项作为验收。上机后从另一台机器扫描公网 IPv4/IPv6，并核对 `docker compose ps`、`ss -lntup` 与供应商规则；禁止把 Docker socket 挂入应用或把公共 CI runner 放到生产主机。

数据库身份沿用 P3-02 的 runtime、migration、maintenance、mediaMaintenance、backup 和 11 个 NOLOGIN owner；应用不持有维护/备份/引导文件。宿主机 root/Docker 访问等同高权限管理。秘密、媒体和备份工作区分别 0700，文件 0400/0600，Git/镜像/公开目录之外；数据库备份中包括账号哈希、Session Token 和独立业务签名密钥，按最高敏感级别保管。

依据：[Ubuntu OpenSSH](https://documentation.ubuntu.com/server/how-to/security/openssh-server/)、[Ubuntu 安全建议](https://documentation.ubuntu.com/server/explanation/security/security_suggestions/)、[Docker/UFW 边界](https://docs.docker.com/engine/network/packet-filtering-firewalls/)、[Docker daemon 权限](https://docs.docker.com/engine/security/)。

## 只读健康检查与告警

在装有 Node24 和 Docker CLI 的受信运维主机运行：

```sh
# 全部为非秘密参数；磁盘路径指向实际保存数据库、媒体/备份的挂载点。
MQ_OPS_PROJECT=mq-production \
MQ_OPS_DEPLOYMENT_ID=00000000-0000-4000-8000-000000000000 \
MQ_OPS_DISK_PATH=/var/lib/docker \
MQ_OPS_ORIGIN=https://approved-domain.example \
MQ_OPS_BACKUP_RECEIPT=/srv/mq/backup-status/verified.json \
node scripts/production/operations-check.mjs
```

输出只包含指标及固定故障码，不输出 container Env、日志、凭据、正文或证书身份。检测主机可用内存、每 CPU load、磁盘剩余和 inode、三个服务存活/健康/OOM、容器内存占用、app/PG 是否误发布端口、实际 TLS 验证/证书剩余天数及已验证备份的新鲜度。任一失败退出 1；无法读取数据也退出 1，不以“没有指标”当健康。没有网络证书验证例外；本地临时 CA 仅在测试函数中显式信任。

阈值初值：磁盘保留 8GiB、inode 至少 5%、主机可用内存 256MiB、每 CPU load ≤1.5、容器内存 <90%、证书至少 14 天、备份不超过 26 小时。load/瞬时内存需要连续样本判断是否扩容；脚本报错不自动重启/删数据。Windows 只能证明解析及本地 Docker/TLS 行为，Linux 内存/inode 指标须在真实主机验证。备份 receipt 是本机运维证据，不证明异地副本存在。

建议负责人批准后用 systemd timer 每 5 分钟运行只读检查，非零退出接入已批准的通知渠道，每日核查备份任务结束状态。不在本轮安装 timer 或发送外部通知。通知只带固定码和时间，不粘贴环境、数据库 DETAIL 或私密日志。没有告警接收人和实际送达演练时，不能声称监控已上线。

## 磁盘不足、证书及恢复处置

- 低磁盘：先查 `df -h`、`df -i`、`docker system df`、PG/WAL和备份工作区大小（不打印文件内容）；保持媒体写入拒绝机制。停止新增上传/发布及备份大任务，保留只读访问；若数据库空间风险已逼近阈值，进入维护并停止 app。禁止 global prune、删 PG/WAL、未知媒体或历史引用图片。只清理由维护工具确认的失败对象，或经批准的过期加密快照；扩盘/迁移或降低保留周期另行确认。
- 40GB 空间不能同时无限保留镜像、明文打包、加密备份和恢复副本。备份前必须满足脚本实际容量检查；一份本盘 Restic 仓库只用于演练/短暂中转。媒体写入余量不是硬配额，并发/其他进程仍可耗尽磁盘，真实主机需设置容量上限和告警。
- HTTPS：检查 DNS A/AAAA 指向、系统时钟、80/443 入站、CA 出站、Caddy `/data` 可写且持久、磁盘空间；使用实际 TLS 探测核实剩余天数和信任链。Caddy 自动续期不代表无需监控。查脱敏 warning/error 时不要公开完整日志；不要通过关闭 TLS 校验或反复删除证书目录解决续期失败。[Caddy 自动 HTTPS 条件](https://caddyserver.com/docs/automatic-https)。
- 泄露/异常：先隔离入口、停止 app 和其他写进程，保留受控审计证据；暂停数据库写身份，按轮换手册撤销 Session、更换相关秘密并验证旧凭据无效。不要先销毁日志、回滚到旧密钥或在工单中粘贴密码。

## 更新与回滚

1. 负责人批准匹配 SHA 的独立 Review、全部 CI 和目标镜像 digest；记录当前/候选 digest、001–008 checksum、manifest deploymentId 和秘密文件版本号（不记录秘密值）。本轮没有实现 GHCR 发布/CD，也不把本地 image tag 当成受签名发布产物。
2. 进入短维护窗口，停止 app 及所有维护写任务；执行 pause、等待排空，制作并校验加密成套备份，记录 snapshot ID。备份失败不继续升级。没有回滚兼容性结论也不继续。
3. 备份完成后、app 和其他维护进程仍停止且数据库仍在私网时，显式 resume 数据库 LOGIN（pause 也关闭了 migration，不能在暂停状态直接迁移）。仅启动独立迁移工具执行受审迁移，再 provision/audit；本轮不新增或修改历史迁移。部署候选 digest 后先在受控入口验收健康、公开故事/图片、登录和管理权限。验证通过后由负责人决定开放开关；不要将 main push 直接视为生产部署授权。
4. 应用回滚只切回已证明兼容当前 Schema、内容版本、权限和秘密合同的前一 digest。停止新实例再切换，不回写旧秘密。数据库无法兼容时优先向前修复；禁止 reset/down migration。
5. 灾难恢复是另一项显式授权：向全新目标恢复已核实 snapshot，撤销旧 Session、清除发布/审核密钥，重新配置身份和新秘密，按恢复手册验收后再切流量。快照之后的写入会丢失；必须确认实际 RPO。备份不能替代发布回滚，切旧镜像也不能替代数据库恢复。

## 上线人工门禁

- [ ] VPS/域名/预算及线路测试、管理来源和运维负责人已确认。
- [ ] 独立安全 Review 匹配最终提交；PR #48/#50 及本 PR 的真实合并状态核实。
- [ ] SSH 第二会话、控制台恢复、补丁重启、IPv4/IPv6 防火墙和外部扫描有证据。
- [ ] runtime/11 owner 权限核验通过；秘密只按服务挂载，生产密钥生成另获授权。
- [ ] Session Token Spike 的风险处置经负责人和独立安全审查确认。
- [ ] 正式 HTTPS、代理链、CSRF/Secure Cookie、资源峰值和失败时拒绝均在目标主机通过。
- [ ] 选择离机备份目标、保留周期、RPO/RTO；独立保管解密密钥，完成离机恢复与通知送达。
- [ ] 明确生产备份密码轮换不使旧备份失去解密能力；主机失陷后重建信任而非仅改一个密码。
- [ ] 上线/回滚批准、合成 staging 验收、真实管理员初始化及真实注册/留言/发布开关分别获授权。

以上仍依赖 VPS 的事项未打勾。这里没有证明“生产安全已完成”，也没有采购或公网部署。
