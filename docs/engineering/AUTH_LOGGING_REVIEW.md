# P2-04 PostgreSQL 日志复核

本记录属于 [PR #16](https://github.com/SynapseOperator/mq-story-blog/pull/16) 的补充验收。它区分数据库日志、应用日志和客户端响应，不以应用 `console` 脱敏推导数据库日志安全。未开放真实用户；本轮不部署，也不修改已有开发数据库或全局 Docker 设置。

## 原始问题与范围

Quality #20 的故意失败测试使用随机生成的合成账号与隔离临时 PostgreSQL 数据库。日志中的 `@accounts.invalid` 来自测试创建的内部兼容标识，**不是实际账号或真实邮箱**。原日志不能因修复后通过而改写成不存在；测试失败/原始记录按受限诊断材料保留，不复制到 PR 正文或公开附件。

应用侧只记录固定错误类别，不能控制 PostgreSQL 服务进程自己的 stderr。PostgreSQL 默认 `log_error_verbosity=default` 下，CHECK/NOT NULL 的 DETAIL 可以包含失败整行；UNIQUE/FK 的 DETAIL 包含冲突/缺失键值。参数化 SQL 防 SQL 注入，但不会自动消除这些数据库生成的 DETAIL。将 `log_parameter_max_length_on_error` 设为 0 也不等于隐藏失败整行。错误 SQL 本文、绑定参数和驱动 Error 则是另外的暴露通道。[PostgreSQL 18 日志参数](https://www.postgresql.org/docs/18/runtime-config-logging.html)

## 本项目控制与实际边界

配置单一来源为 `config/postgresql/log-privacy.conf`：

- `log_destination=stderr`，`log_error_verbosity=terse`，不输出 DETAIL/HINT/QUERY/CONTEXT。
- `log_min_error_statement=panic`、`log_statement=none`，关闭通常的失败语句及语句采样；两个参数长度设置为 0。
- 保留 `log_min_messages=warning`，包含 ERROR/FATAL/PANIC；前缀包含时间、进程 ID 和 SQLSTATE。约束错误主消息中的表名/约束名继续可审计。

上述参数不将整个错误审计关闭，也不对约束错误进行忽略。审计中预期存在的 23514、23505、23502、23503 必须与非预期限流竞争分开分析。

**该配置针对 stderr，不是通用日志脱敏器。** PostgreSQL 18 的 [CSV writer](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/error/csvlog.c) 与 [JSON writer](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/error/jsonlog.c) 仍会序列化 detail；不能仅设 TERSE 后开启 csvlog/jsonlog 并沿用本验收结论。托管平台、审计扩展、慢查询采集和 APM 需要分别检查其实际输出。

主 ERROR 本身也可能包含输入，例如 `invalid input syntax`，即使使用参数绑定与上述配置仍然如此。应用必须在数据进入驱动前验证类型、长度与结构；SQL 使用绑定参数，错误模板/触发器不得拼接密码、token 或内部邮箱。应用不得打印原始驱动错误（其中仍有 DETAIL）、请求体、Cookie、Authorization 或连接串。日志方案只减少暴露面，不能承诺所有 PostgreSQL 错误均无内部字段。

既有本机实例不因本次修复被强制重启或改全局参数；临时测试库设置与新建 CI/Compose 服务配置分别应用并核实。历史服务若尚未以新配置重建，其旧日志策略不自动改变。正式开放前必须在实际数据库环境检查生效参数和输出格式。

## 可复现的真实数据库证据

执行：`node scripts/auth/database-log-audit.mjs`。脚本创建两台独立 PostgreSQL **18.6** Docker 临时容器，loopback 随机端口、SCRAM 随机密码、PostgreSQL 18 正确数据目录上的 tmpfs；不读取 `.env.db.local`，不访问已有开发/测试实例，不使用 Mock。它在空库执行已提交的认证 SQL，再故意触发错误。只清理带有本次随机所有权标签的容器。

2026-10-23 Windows 实测，命令退出 **0**：

| 检查 | 默认配置 | 受控 stderr 配置 |
|---|---|---|
| CHECK/NOT NULL/UNIQUE/FK/除零等预期错误 | 7 个，均有审计 | 7 个，均有审计 |
| 三类合成标记：内部邮箱、密码 hash 哨兵、Session token 哨兵 | 3/3 出现在数据库日志 | 0/3 |
| DETAIL/STATEMENT/CONTEXT/QUERY | 可出现 | 此组错误中均未出现 |
| ERROR、SQLSTATE、关键约束名 | ERROR 存在；默认前缀无 SQLSTATE | 全部断言通过 |
| 参数类型错误负向对照 22P02 | 主 ERROR 仍包含合成输入 | 主 ERROR 仍包含合成输入 |
| 客户端驱动 Error 的敏感 DETAIL | 仍存在 | 仍存在，需应用独立处理 |

每台实例共 8 个预期失败；最后一个负向对照刻意证明配置的限制，不能将它误写为“全日志无敏感信息”。初次原始记录在本机 `C:\Users\33684\AppData\Local\Temp\mq-auth-log-audit-T6mfpl`，最终复测保留于 `mq-auth-log-audit-7hFsOx`，均未覆盖；目录 ACL 仅当前用户与 SYSTEM，Unix 运行时目录 0700/文件 0600。脚本终端仅输出版本、计数、布尔结论和证据路径，永不回显原始 SQL/driver/container 错误。原始记录只有合成哨兵，不应上传到 GitHub；CI 可保存脱敏摘要，不上传 raw 文件。

CI 在迁移和故意失败测试前，校验显式 GitHub 临时服务身份并应用该策略；脚本拒绝本地 env 回退。Compose 两个服务命令与配置源一致性由自动测试核对。既有本机实例只在新建随机测试库上设置数据库级参数，不修改已有库/全局默认、不重启实例。本机临时库检查同时确认设置生效。

本轮 Windows 验收：工程检查含 **42/42** 单元测试；故事/迁移数据库检查 **31/31**；真实认证 HTTP **35/35**、HTTPS **8/8**；生产页面浏览器 **23/23**，0 意外运行时/控制台错误、0 响应字段泄露。单进程真实登录 20 并发实际为 6 成功 + 14 明确 `AUTH_HASH_BUSY`，校验被拒请求无 Cookie/Session，之后成功恢复。低于容量的单/双进程 HTTP 和 HTTPS 正误密码并发没有内部/限流存储失败。项目与框架限流故障注入均为 `AUTH_LIMITER_ERROR`，Account/Session 故障为 `AUTH_INTERNAL_ERROR` 并完整回滚，均不冒充容量拒绝。Linux 结果与最终提交 SHA 记录在 PR #16 的新 CI 证据中。

## 正式部署前的访问控制门槛

日志、诊断包、备份、数据库快照与 WAL 都按认证敏感资料管理；Session token 当前原值存库，密码 hash 和内部邮箱也可能存在于这些产物。只有被授权运维/安全审查者可读，应用运行身份不应获得日志目录、备份桶或迁移管理员权限；日志管理员权限与应用数据库最小权限独立检查。禁止公共链接、公开 artifacts、共享终端粘贴和默认完整错误上报。

存储与传输加密，密钥访问单独控制；访问留审计，限制导出，制定有限保留/轮换/删除策略。备份恢复到隔离环境，测试不得借用生产快照。临时提高日志详细度必须限定人员、时间和作用域，并核查恢复策略；故障处理也不能永久打开参数/语句记录。PostgreSQL 官方明确要求保护服务日志且合理轮换，[日志维护与敏感资料](https://www.postgresql.org/docs/18/logfile-maintenance.html)。这些实际部署控制尚未实施验收，不能以本地/CI 配置替代。
