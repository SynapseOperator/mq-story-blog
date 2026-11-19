# P4-01：Ubuntu 主机预检与告警接入

关联 Issue #53。本页保留 P4-01 的合成验证与通用操作说明，不替代生产数据库、秘密轮换或备份恢复流程。后续 P4-02 真实只读结果、无需远端 Node 的采集方式及待授权加固步骤见 [VPS_READINESS.md](../archive/VPS_READINESS.md)。尚未安装软件、修改 SSH/防火墙或向外部通知渠道发送消息。

## P5-05C：正式操作前需补齐的只读核验

上段是 P4-01 时点说明。后续主机加固、Docker 和合成部署、单条飞书送达已分别验收；P5-05C 不再次修改真实 VPS。现有 P5-05B 只读采样显示公网80/443/3000/5432/2375/2376没有监听，但云安全组和全部用户任务仍未核实。以下是待真实执行的检查清单，不是已经通过的验收。

| 检查 | 只读证据及判断 | 不允许的替代结论 |
|---|---|---|
| 云安全组 | 在供应商官方控制台核对这台 VPS 的全部绑定规则、来源 CIDR、IPv4/IPv6；保存不含 Token 的脱敏规则记录 | UFW 拒绝或宿主无监听不能证明云规则安全；无控制台权限就记未验证 |
| 系统任务 | `systemctl list-timers --all --no-pager`、`systemctl list-unit-files --type=service --no-pager` 的名称/状态；核对 cron/anacron/at 是否安装及任务存在性 | 不直接收集 ExecStart、Environment、完整 journal 或 crontab 内容，这些可能包含秘密 |
| 用户任务 | 列出 `/var/spool/cron/crontabs` 的任务属主，核对 `/etc/cron.d`、`/etc/crontab` 和各运维用户的 systemd timer；在本机安全会话逐项检查，只记录任务用途、周期、目标及是否冲突 | root 的任务清单不能代替 mqops 和其他用户；不能以“没有 MQ timer”推断主机没有其他需保留服务 |
| Docker 实际网络 | Docker>=28，原生 dockerd 参数/配置无 `allow-direct-routing`，目标 bridge 无 routed/nat-unprotected/trusted interface；核对 compose 与实际容器的端口/IP | 不打印完整 daemon 配置；不能只看 Compose 文本或 UFW。私有预览执行器另有失败关闭的准入检查 |
| 容量与峰值 | `free -b`、`df -B1`、`df -i`、`docker stats --no-stream`；获准执行后在初始化/备份/更新全过程采样，保留最高值 | 现有约3GiB空闲内存、31GiB空闲盘仅为历史静态采样；8GiB门槛不降低；只常驻一套 MQ |
| 合成恢复入口 | 比对已记录项目名、卷、媒体及备份清单；核对最新快照时间、完整校验与精确恢复回执 | 本地加密文件存在不等于新鲜或可恢复。当前合成环境停机前须有负责人认可的恢复点；本轮不写新快照 |
| 公网 TLS | 开放批准前核对 A/AAAA/CAA、云/主机IPv6边界；80/443开放后验证公共链、SAN、证书有效期与续期日志的固定状态 | 私有测试 CA、SSH 隧道成功不代表 ACME 可达或公共证书有效 |

正式调度待独立批准：每日完整备份和 `check --read-data`，每日新鲜度/仓库 ID 检查，7 daily / 8 weekly 仅 dry-run；主机/容器/数据库/磁盘每5分钟检查，公共 HTTPS/证书由 VPS 外部探针检查。飞书按既有脱敏发送器和有界重试执行，首次真实故障告警、抑制与恢复通知须明确验收；历史单条测试不代替自动闭环。执行前使用 [生产上线顺序](PRODUCTION_LAUNCH.md) 的新 gate、planId 和逐阶段授权，不沿用历史批准。

## 连接前先完成的事

负责人已确认完成暴露的初始 root 密码轮换、mqops 公钥登录、第二会话和可信控制台指纹核对，并授权本轮只读连接。不要再将未轮换旧密码列为当前阻塞。新密码和私钥不能进入聊天、Git、命令参数或日志，不使用 `StrictHostKeyChecking=no` 绕过身份确认。后续 SSH/防火墙变更仍需单独授权。

首版发布镜像只支持 `linux/amd64`。供应商的“Ubuntu 24.04 / 香港”标签不能证明实际架构、资源、线路或安全配置；若实际是 ARM，应停止使用当前镜像并另行评估，不能靠容器模拟得到的 x64 指标作主机验收。

## 原生只读检查

新装 Ubuntu 通常没有 Node.js。不要为了运行预检脚本擅自安装整套开发环境。获准连接后，可以先执行以下只读命令；仅记录必要字段，不粘贴完整主机资料或环境变量：

```sh
uname -m
sed -n '/^ID=/p; /^VERSION_ID=/p' /etc/os-release
getconf _NPROCESSORS_ONLN
free -b
df -B1 /
df -i /
timedatectl show --property=NTPSynchronized --value
timedatectl show --property=Timezone --value
ip -j address show
ss -H -lntu
cat /sys/module/apparmor/parameters/enabled
ufw status
sshd -T
docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}'
docker --host unix:///var/run/docker.sock compose version --short
```

命令缺失或权限不足必须记录为“未验证”。不要自动 sudo、加入 docker 组、安装 Docker、启用服务或修改配置。`ss`、`ip`、`ufw` 和 `sshd -T` 原始输出仅在受控终端查看；对外只报告协议/端口分类、IPv4/IPv6是否配置及必要布尔开关，不粘贴地址、主机密钥路径或完整 SSH 配置。

已具备 Node24 的受信主机可运行：

```sh
node scripts/production/host-preflight.mjs --disk-path=/
```

如果数据库或媒体使用另一挂载点，分别用它的实际目录执行。脚本不会创建目录，也不会遍历或输出媒体文件。它只读 `/etc/os-release`、`/proc/meminfo`、AppArmor内核状态、文件系统容量，并执行上述固定的本地只读命令。Docker 明确使用本机 Unix socket，不继承 `DOCKER_HOST` 或远端 context；rootless 或非标准 socket 会显示未验证，不自动改接其他 daemon。

JSON 只包含固定检查码、时间、版本、资源数值与端口分类，不输出主机名、IP、PID、进程命令、环境变量或原始错误。`status` 与退出码：

| 状态 | 退出码 | 含义 |
| --- | --- | --- |
| `pass` | 0 | 本次自动资源检查通过，仍有人工安全门槛 |
| `warn` | 2 | 工具/时间状态未知、低于规划规格或需人工检查的占用端口 |
| `block` | 1 | 架构/系统不匹配、资源不足、危险监听或监听状态无法核验 |

当前门槛包括 Ubuntu24.04、Node24、x64、8GiB 磁盘余量、5% inode 余量、256MiB 可用内存。现有 app/PG/proxy 内存上限合计 2432MiB，主机可见总内存小于3GiB阻塞，3–3.5GiB警告；CPU不足4核或磁盘小于35GiB警告。这些是候选配置的预检线，不是容量压测结论。工具采用 Linux `MemAvailable`，同时报告 Swap总量/可用量与配置时区；无Swap只警告，不自动创建交换文件。Windows/容器采样不替代目标 VPS 的宿主机容量。

IPv4/IPv6仅报告非loopback接口是否具有对应地址，包含link-local，不能据此断言公网路由或可达性。AppArmor、UFW、SSH有效默认配置只读检查，权限不足明确 `null`/`warn`；不自动sudo。SSH的Match条件仍须针对实际运维来源人工核验，UFW未启用也可能由其他防火墙承接，必须人工确认；不能把UFW active当作云/容器入口已经安全。

3000、5432、2019、2375、2376 的非 loopback 监听阻塞；80/443 已占用需要先识别既有服务；其他非 loopback 端口提示人工核对。22 端口监听本身不能证明 SSH 已限制来源。返回的 `unverified` 明确保留 SSH 策略、云/主机防火墙、外部 IPv4/IPv6 扫描、账单和生产安全审查。

## 初始化与加固的执行顺序

以下步骤仍需负责人授权和人工执行，脚本不会替用户修改主机：

1. 保留供应商控制台与现有登录会话。建立独立 sudo 运维账号，配置负责人批准的公钥，从第二个终端验证登录成功。
2. 核对 Ubuntu 的 sshd 配置合并结果，再设置禁用 root 登录、密码与键盘交互认证。先用 `sshd -t` 检查，reload 后验证新会话，最后才关闭旧会话。不要在新密钥尚未验证时切断恢复通道。[Ubuntu OpenSSH](https://ubuntu.com/server/docs/how-to/security/openssh-server/)
3. 先批准 SSH 来源 IP/VPN，再核对云防火墙与主机规则。公网仅 TCP80/443；SSH仅管理来源。IPv6 同样检查。不要暴露数据库、应用直连、Caddy 管理或 Docker API。
4. Docker 发布端口可能绕过 UFW 的普通 INPUT 规则；不能用 `ufw status` 宣称完成隔离。核对 Compose 发布端口，并从另一台获准机器验证公网 IPv4/IPv6。不得关闭 Docker 的防火墙管理来“修复”网络。[Docker 防火墙边界](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
5. 规划安全更新、重启窗口、时间同步与 AppArmor；镜像在 CI 构建。4GB 主机不同时常驻两套完整 staging/production。正式秘密、数据库身份、媒体目录、告警渠道与离机备份仍分别验收。

## 轻量 webhook 合同

`scripts/production/alert-webhook.mjs` 是通用 JSON webhook 发送器，不是某个聊天平台的完整适配器。接收端须接受以下固定信封；真实渠道的鉴权、格式和送达确认在接入时验证：

```json
{
  "version": 1,
  "eventId": "00000000-0000-4000-8000-000000000001",
  "deploymentId": "00000000-0000-4000-8000-000000000000",
  "checkedAt": "2026-11-06T00:00:00.000Z",
  "failures": ["DISK_RESERVE_LOW"]
}
```

调用方提供的报告仅使用 `deploymentId`、`checkedAt` 和固定 `failures` 码；未知附加字段被丢弃，不转发 `sample`、日志、自由文本或响应正文。支持现有 operations 码及 `BACKUP_FAILED`、`RESTORE_FAILED`、`RELEASE_FAILED`。健康报告不读取 webhook 秘密、不发送网络请求。

现有 `operations-check.mjs` 的JSON现含安全的 `deploymentId`，可直接重定向为报告。若UUID有效但Docker、磁盘等探针抛错，仍输出当前固定 `OPERATIONS_CHECK_FAILED` 报告并退出1；UUID无效时只输出固定stderr、不伪造目标。下面假设已按运维手册设置 `MQ_OPS_*`，报告目录已由运维人员准备：

```sh
umask 077
monitor_status=0
node scripts/production/operations-check.mjs > /srv/mq/operations/alert.json || monitor_status=$?
alert_status=0
MQ_ALERT_REPORT_FILE=/srv/mq/operations/alert.json \
node scripts/production/alert-webhook.mjs || alert_status=$?
test "$monitor_status" -eq 0 && test "$alert_status" -eq 0
```

示例保留监控的非零结果，不因告警预览成功就把检查变绿。不要使用 `monitor && alert`，那会在最需要告警时跳过发送器。经批准的真实发送再增加下述webhook秘密文件与 `--send`；无效UUID需要先修正配置。

URL 可能含渠道 token，必须位于 Git 外的0400/0600普通文件，沿用既有秘密读取约束；不得将 URL 放入命令行或报告。报告文件最多16KiB。默认只生成安全 payload，不读 URL、不联网：

```sh
MQ_ALERT_REPORT_FILE=/srv/mq/operations/alert.json \
node scripts/production/alert-webhook.mjs
```

只有接收目标经负责人批准后，才显式发送：

```sh
MQ_ALERT_REPORT_FILE=/srv/mq/operations/alert.json \
MQ_ALERT_WEBHOOK_URL_FILE=/srv/mq/secrets/alert_webhook \
node scripts/production/alert-webhook.mjs --send
```

生产发送只允许 HTTPS，使用系统信任链，拒绝 URL 用户信息和重定向。单次请求绝对超时5秒；网络失败、429或5xx最多发送两次，两次沿用同一事件 ID。接收端应按 eventId 去重；响应丢失时可能重复收到，不能保证通知 exactly-once。其他4xx不重试。响应正文不读取/转发，任何失败返回固定错误码及非零退出；HTTP2xx只说明接收端接受请求，不证明负责人已经阅读。

本轮仅模拟渠道，未配置常驻 scheduler、真实接收人或外部消息平台。建议后续批准后每5分钟采样，将脱敏报告交给发送器；持续故障的跨周期去重、恢复通知和升级联系人需要在渠道接入时确定，不在这里搭建复杂告警系统。正式凭据泄露处置继续使用 [秘密轮换手册](SECRET_ROTATION.md)。

备份 `OnFailure` 模板使用 `--backup-failure=<部署UUID>`，只生成当前时间的固定 `BACKUP_FAILED` 报告，忽略 `MQ_ALERT_REPORT_FILE`。因此即使备份在读取配置前失败，也不会依赖不存在或过期的状态文件。默认仍dry-run；该参数可与一次显式 `--send` 组合，重复/未知参数或无效UUID均拒绝。发送器不会读取systemd日志或执行数据库清理。

## 已执行与尚未执行

`node --test tests/production-host-preflight.test.mjs tests/production-alert-webhook.test.mjs` 在 Windows 与非root、只读、无外网的 Linux operations 容器均通过21项测试，退出码0。覆盖真实本地 HTTPS、合成 CA、无效信任链、403/429/503、重定向、响应丢失、有界重试、dry-run 零请求、实际发送失败的非零退出、OnFailure无状态文件及输出脱敏。Ubuntu24.04 的健康/故障分类使用合成采样；实际 collector 也读取了本机/容器，明确保留其环境限制。

以上为 P4-01 时点证据；P4-02 已补充真实架构/容量与一次 SSH 只读采集，见 [VPS_READINESS.md](../archive/VPS_READINESS.md)。云防火墙、特权 SSH 配置、外部扫描、时间同步修复、正式证书、告警送达及主机容量压测仍未完成，不能由本地绿色结果替代。
