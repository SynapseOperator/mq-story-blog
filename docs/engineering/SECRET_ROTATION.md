# 密钥轮换与凭据泄露处置

本方案属于 P3-03 / Issue #51，依赖 PR #50 的显式部署 manifest、文件秘密、5 个独立数据库身份。只在随机 PostgreSQL 和容器合成环境验证，没有生成或更换正式凭据。轮换采用短维护窗口，不宣称零停机。

## 需要分别轮换什么

| 凭据 | 影响与处理 | 当前证据边界 |
| --- | --- | --- |
| runtime / migration / maintenance / mediaMaintenance / backup 数据库口令 | 只影响新连接；旧连接不会自动消失。先阻止新写连接并排空，再原子更新 5 个口令、替换各自秘密文件、重启对应客户端 | 隔离 PG18 SCRAM 验证旧口令拒绝、新口令成功，角色权限没有增加 |
| AUTH_SECRET | MQ 使用单一 secret；改变 Cookie 签名验证及限流 HMAC 命名空间。删除全部 Session、换文件、重启 app，所有用户重新登录 | Better Auth 1.7.12 Cookie 与 Session 实验见 [SESSION_TOKEN_SPIKE.md](../archive/SESSION_TOKEN_SPIKE.md)；不启用未经本项目验证的多 secret 模式 |
| SESSION_STORAGE_KEY | 独立保护数据库Session及身份绑定。停入口/app、pause排空、撤销Session、原子换文件并重建app；可保持AUTH_SECRET不变 | 错key拒绝旧会话，无原值fallback或长期双key；恢复新key并清Session，见[安全存储](SESSION_STORAGE.md) |
| AUTH_PROXY_SECRET | Caddy 和 app 必须一致；不同步时认证请求拒绝。停止入口/app，替换两个挂载源并重建两个容器 | 使用实际 HTTPS 容器演练；无旧、新代理 key 同时接受的过渡期 |
| 发布 / 留言审核 HMAC | 独立私有 schema 与 app 文件必须配对。两类 key 原子替换，撤销全部 Session；重新登录之后才允许生成新签名 | 真实 PG 验证旧 key、旧会话失败，新 key 发布/审核成功，错误旧 key 与事务失败整体回滚 |
| Restic 仓库密码 / 仓库密钥 | 与上述秘密分开保管；本轮运维工具不自动删换 Restic key。备份仓库含旧数据库秘密，应用轮换并不会重新加密已有快照 | 仓库密码泄露不能只 `key passwd` 后宣称旧备份安全；新建仓库/密钥、重新备份并验证，再受控退休旧仓库；远端副本需独立授权 |
| bootstrap / VPS SSH | 不挂载到 app。bootstrap 是离线高权限身份，SSH/root/Docker 是主机信任边界 | 本轮不自动轮换它们。泄露应隔离主机、人工恢复可信控制通道并核对整机，而非仅换应用密码 |

数据库 LOGIN 口令采用标准 SCRAM-SHA-256 verifier，由 Node crypto 根据受限 ASCII 随机口令派生；`ALTER ROLE` 只携带 verifier，不携带明文口令。SCRAM verifier 也属于敏感认证材料，不记录 SQL/参数。数据库日志策略在命令前强制核验。[PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/18/sql-alterrole.html)、[口令认证](https://www.postgresql.org/docs/18/auth-password.html)。

Better Auth 官方的 versioned secrets 支持部分密文/Cookie 的兼容轮换，但不能据此假定当前 MQ 单一 `secret` 配置能够无缝保留会话；具体以锁定源码及测试为准。[官方 Cookie 说明](https://better-auth.com/docs/concepts/cookies)。MQ 没有邮箱找回流程，本方案不增加邮件、恢复令牌或公开密钥修改接口。

## 受控命令

执行者必须能读取部署 manifest 和专用 bootstrap 连接文件，同时拥有该数据库。工具核对数据库名字、部署 ID 标签、PG18、未切换身份的 superuser/数据库 owner、5 个角色属性和日志策略。运行账号调用会失败。权限文件使用现有 0400/0600、非符号链接、Git 之外的合同。

每次操作均要求 `--confirm-deployment=<完整 deploymentId>`；staging 也需确认，防止复制错误命令。参数只包含公开 ID 和操作名称，不能放密码、连接串或 key。

```sh
node scripts/production/rotation-cli.mjs pause --confirm-deployment=<deploymentId>
node scripts/production/rotation-cli.mjs database --confirm-deployment=<deploymentId>
node scripts/production/rotation-cli.mjs signing --confirm-deployment=<deploymentId>
node scripts/production/rotation-cli.mjs revoke-sessions --confirm-deployment=<deploymentId>
node scripts/production/rotation-cli.mjs resume --confirm-deployment=<deploymentId>
```

所有命令需要 `MQ_DEPLOYMENT_CONFIG`、与 manifest 一致的 `MQ_DEPLOYMENT_ENV`、`BOOTSTRAP_DATABASE_URL_FILE`，只能作为按需维护容器的只读挂载，不能加入 app 常驻环境。

`database` 另需 `MQ_NEW_ROLE_PASSWORDS_FILE`：JSON 恰好包含 migration/runtime/maintenance/mediaMaintenance/backup 五个独立值，满足 `[A-Za-z0-9_-]{32,128}`。正式随机秘密由授权操作人在外部秘密目录准备，不由本手册示例生成。

`signing` 另需四个文件变量：`MQ_PREVIOUS_PUBLISH_SIGNING_KEY_FILE`、`MQ_PREVIOUS_COMMENT_SIGNING_KEY_FILE`、`MQ_NEW_PUBLISH_SIGNING_KEY_FILE`、`MQ_NEW_COMMENT_SIGNING_KEY_FILE`。四个 32-byte 值必须不同；旧值须与数据库一致。历史 SQL 006/008 不变，签名 payload 和数据库函数不变。失去旧 key 或恢复后 key 表已清空时，此命令拒绝；使用另行审核的首次初始化/灾备流程，不能自动退回旧值。

### 正常维护顺序

1. 核对受审镜像、目标、维护时间和可恢复加密备份；关闭入口，停止 app、上传/清理及其他写入维护容器。退出操作者已有运行身份连接。
2. 调用 `pause`。工具先提交四个写身份的 `NOLOGIN`，再等其连接排空，最多 5 秒。backup 保持只读 LOGIN，可在此期间备份。`NOLOGIN` 不终止既有连接；忙连接会使命令非零退出，保持禁止新登录，不强杀或自动恢复。
3. 按需执行 `database`、`signing` 或 `revoke-sessions`。`database` 先将 backup 也设为 NOLOGIN，再要求它没有既有连接；若忙则拒绝并保持关闭，五口令一起提交。`signing` 在同一事务验证两个旧 key、替换两个新 key并撤销 Session。AUTH_SECRET 或 SESSION_STORAGE_KEY 轮换单独调用 `revoke-sessions`。身份/目标/密钥不匹配和数据库错误均拒绝，不输出内部值。
4. 将新的文件原子安装到受控外部秘密目录，保留正确 owner/mode。Compose file secret 使用 bind mount；替换文件 inode 后应 **force-recreate app/proxy**，不能假定普通 restart 会重新挂载新的 inode。不得将旧文件临时放入 Git 或公开目录。DB 口令变化时同步对应连接 URL 文件，不能继续使用旧五口令 JSON。
5. `resume` 恢复五个角色的 LOGIN，不启动 app、不放行业务开关。该操作和备份/轮换使用同一 advisory lock，避免恢复登录与备份同时进行。再运行 runtime 权限审计，重建 app/proxy，验证健康、旧 Cookie/旧 DB 口令/旧签名拒绝和新登录正常；失败保持入口关闭，重新 `pause`，不要回滚到泄露的 key。
6. 人工确认新配置和回归后才恢复入口。记录 UTC 时间、部署 ID、镜像 digest、操作类型、撤销 Session 数量和结果，不记录账号口令、key、Cookie、Session Token、正文或 SQL。

`pause` 和重复撤销会话可重试；成功 `signing` 使用原旧 key 再次执行会失败，避免无法确认结果时盲目重放。若命令响应丢失，先核对安全状态和文件版本，不自动生成第三套 key。DB 事务回滚保留旧值；进程中断不会执行 `resume`。应用 secrets/数据库之间没有跨资源原子事务，因此停机窗口和人工核对是有意的边界。

维护锁只协调本项目遵守合同的命令。持有 bootstrap/root 的人可绕过锁或修改数据库；不能把此机制说成能抵御主机完全失陷。当前没有无限期轮换 daemon、第三方 vault、双 key/key-id 协议或自动生产恢复。

## 泄露后的处置

1. 先通过可信通道关闭公网入口和停止 app；冻结部署/清理任务，保全受控审计证据。不要将疑似秘密粘贴到 Issue、日志或聊天。
2. 确定泄露范围：应用 Cookie、AUTH_SECRET、runtime URL、bootstrap、主机、备份密码可能需要不同响应。只改变 DB 密码不会撤销已建立连接；只改变 AUTH_SECRET 不撤销已有 Session 封装；若存储密钥也泄露，必须独立轮换并撤销会话。历史 008 备份仍可能含原值 Token。
3. 在确认可信的主机/维护镜像中 `pause`，撤销全部 Session，按涉及范围更换独立秘密及 DB 口令。若 root/Docker/bootstrap 可能泄露，按整机失陷处理；从受审镜像与已验证备份恢复到新的隔离主机，不信任原机就地“修好”。
4. 完成新配置和权限审计、拒绝旧凭据测试后，再由负责人决定开放。已泄露的私密内容不能靠轮换撤回；备份读取与数据泄露另行记录。

## 已运行验证与限制

`node scripts/production/rotation-tests.mjs` 在独立随机 PG18 库执行：错误目标/运行身份拒绝；已有连接使 pause 失败但 NOLOGIN 持续；备份只读可用；maintenance 锁冲突；旧 key 不匹配与第二次 key UPDATE 故障的事务回滚；全 Session 撤销；5 身份 SCRAM 旧口令失败/新口令成功；新 session 和新 key 发布、审核成功；旧 key/旧 session 失败。测试清理仅删除自己创建的随机库/角色，不清空 mq_test 或开发库。

原有 GitHub database service 使用 trust；在那里连接成功不能证明口令正确，套件明确标记该项需 SCRAM 容器演练，不将 trust 结果冒充口令拒绝证据。实际 Linux SCRAM 及 Caddy/Auth 轮换由本 PR 的容器演练覆盖。测试使用合成凭据，全部输出仅固定诊断和统计。

真实 VPS、外部秘密文件安装、应急控制通道、备份密码轮换、人员访问授权、告警送达和停机时长仍待人工验收。测试成功不构成正式生产开放或密钥操作授权。
