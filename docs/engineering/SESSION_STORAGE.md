# Session 安全存储

P5-04 / Issue #63。负责人选择在正式上线前改造；旧原值／简单摘要实验保留在[历史Spike](SESSION_TOKEN_SPIKE.md)。实际应用使用Better Auth 1.7.12的公开DBAdapter与Prisma API，不改依赖源码、Cookie协议或四条HTTP白名单。

## 数据与身份保护

独立`SESSION_STORAGE_KEY`是安全随机32 bytes，以64位小写hex存放于Git外秘密文件。HKDF-SHA256以版本域和不同info分离加密键与查询键。AES-256-GCM使用随机96-bit nonce、128-bit tag；算法由Node原生crypto提供。

- `Session.token`保存`hmac1:<64hex>`查询索引，沿用唯一约束，不是bearer。
- 新增必填`tokenCiphertext`：`v1:<nonce>:<tag>:<ciphertext>`。不另存原Token、数据库密钥或原Token缓存。
- AAD绑定版本、Session ID、User ID、索引、createdAt、expiresAt，防止身份重绑、延期和伪造freshness。updatedAt和设备描述不作为授权依据。
- 所有Token条件都重新计算HMAC，不接受索引前缀直通。读取、列表及join在返回框架前验证并解密，剥离密文字段；MQ公开响应继续删除Token。
- 原Token仍会在框架和浏览器正常生命周期中短暂存在。应用进程或独立密钥失陷可以导致解密，at-rest保护不等于抵御整机失陷。

锁定版本没有完整Session安全存储开关。简单摘要无法恢复原生设备列表所需的撤销凭据；认证加密保留原合同，代价是独立密钥、迁移和明确的adapter适用范围。[官方Adapter](https://better-auth.com/docs/guides/create-a-db-adapter)、[会话管理](https://better-auth.com/docs/concepts/session-management)、[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。

## 框架与并发合同

覆盖create、findOne/findMany、select、双向join、token集合条件、count、update/updateMany、delete/deleteMany、consume和事务。创建前生成UUID，通过公开forceAllowId固定AAD身份；密文字段只在包装器内部schema声明，不能由客户端提交。

MQ仍关闭refresh和Cookie cache，但隔离框架实例验证真实刷新及各类撤销。runtime保持Session SELECT/INSERT/DELETE，无UPDATE；11个函数owner与权限矩阵不变。

更新时，在同一公开Prisma事务内先取得Session的短暂`SHARE ROW EXCLUSIVE`表锁，再验旧封装、按完整旧行CAS consume、INSERT同ID新封装；失败整体回滚，撤销先完成则不重建。既有DELETE权限允许此锁；普通读取并行，短窗口内Session写入串行，不包含密码哈希或外部I/O。

最初仅CAS删除／重插的实验出现真实失败：并发DELETE等待旧tuple后返回0，错过替换行。新回归明确等待数据库锁，再验证原生DELETE及004管理员撤权触发器都删除新行，不只看HTTP200。现有锁顺序未新增AdminGrant／Account反向依赖；未来用户删除等新流程需重新审查。

仅支持MQ已核验的Session模型和默认／UUID身份策略。额外Session插件字段、字段重命名、secondaryStorage、Cookie cache、Token模糊匹配／排序和Session数值increment明确拒绝，不静默透传。其他模型保留官方adapter。

## 009、密钥轮换与恢复

009在事务中锁Session、撤销全部旧会话，再加必填密文列和格式CHECK；User、Account及业务数据保留。001–008字节不改。CHECK只保证格式，密码真实性由应用验证。

已有环境需要维护窗口：停止入口/app和写任务、备份→009→独立key→provision/audit→启动新应用并重新登录。不双读旧格式，不自动回退到008应用。正式生产尚未初始化。

生产通过`SESSION_STORAGE_KEY_FILE`读取，复用普通文件、0400/0600、owner、无链接和Git外路径检查；Compose只默认挂给app。五个应用key与数据库密码均独立。缺失／格式错误拒绝启动；错误合法key拒绝旧会话，不能fallback。应用不生成默认key。

轮换：关闭入口/app→pause排空写身份→受控`revoke-sessions`→原子换key文件→重建app→验证旧Cookie拒绝、新登录成功→批准后恢复入口。可以保持AUTH_SECRET不变，存储key独立轮换。丢失key需要撤销并重新登录，不删除账号或故事。不将key放入argv、日志、镜像或回执。

Restic备份仍含其他私密数据，必须加密，密码另行保管；存储key不随数据库／媒体备份保存。恢复新目标清空Session、使用新key。旧媒体原生restore也改为撤销Session。008备份须先由匹配受审旧工具恢复到新隔离目标，保持关闭，再迁移009并审计；新工具不把缺迁移的恢复当成功。发布合同拒绝跨Schema普通镜像回退，不执行自动下迁移。

## 验证与剩余边界

`npm run test:auth:session-storage`：真实PG18/HTTP，008→009账号故事保留；注册登录、多设备、所有撤销、到期/刷新、独立HTTP实例/监听重启、事务回滚、100条以上批量更新、无UPDATE身份、密文/索引/身份/期限篡改、独立轮换与确定性并发。原16组Spike继续使用隔离001–008库和旧Prisma模型，不放宽009约束。真实进程重启由原认证双Next进程和容器重启回归覆盖；完整管理员HTTP/HTTPS另验证withAdmin。应用日志结论来自真实secret-canary回归，不由实验的静默logger推出。

SQL写权限将自己Cookie重绑另一userId的旧反例现在被拒绝。索引或密文即使附加合法测试Cookie签名，也不能认证。诊断只输出固定阶段和类别，不输出Cookie、key或数据库错误对象。

仍不抵御：任意SQL写者回放一整条曾合法且未到期的封装，可能恢复其原身份旧Cookie；AEAD不能判断数据库状态被回滚，实验明确记录这一边界。换独立key后旧封装不再有效；管理员授权仍另查。任意改写User/Account、主机与密钥失陷、被盗有效Cookie同样需要数据库、主机、HTTPS和应急控制，不能宣称全部数据库完整性风险消失。

最终测试和独立复核见本PR证据。独立Agent复核不冒充GitHub协作者APPROVED；代码测试通过不授权P5-05真实主机操作。

## P5-04 本地验收记录

Windows Node24.19.0 与 Docker Desktop Linux 容器，全部为随机 PostgreSQL 18.6 库、合成账号和媒体。本轮没有连接或修改 VPS。

| 命令/范围 | 退出码与结果 |
| --- | --- |
| `npm run check` | 0；lint、Schema、typecheck、350项单测（Windows344通过/6项既有平台跳过）、Next生产构建 |
| `test:auth:session-storage` | 0；27/27，全部撤销前有3个活跃设备，逐Cookie及DB验证；106行批量更新逐行校验 |
| `test:auth:session-spike` | 0；保留16组历史原值/摘要反例，使用隔离008模型 |
| `test:db`、`test:media` | 0；001→009、旧库升级、drift与原有领域/媒体约束 |
| `test:auth`、`test:admin` | 0；35+8、20+4项HTTP/HTTPS及管理员18组DB，包括重置在途登录、撤权和日志canary |
| `test:publishing`、`test:likes`、`test:comments` | 0；真实权限、并发、HTTP/HTTPS、公开/私有隔离和生产浏览器 |
| `test:admin-drafts`、`test:admin-editor`、`test:admin-preview`、`test:public` | 0；事务/CAS、桌面/390/320/reduced-motion、分享HTML/RSC/metadata |
| `test:media:upload`、`test:media:stories`、`test:media:lifecycle` | 0；上传/进程中断恢复、私有/公开图片、删除并发、原生备份7/7 |
| `test:production:db`、`:rotation`、`:admin` | 0；五类身份、11个owner、真实SCRAM与维护边界 |
| `test:auth:transactions`、`:limiter`、`:logs` | 0；超时负控、真实并发429、数据库日志与应用日志分层验证 |
| `test:production:operations`、`:bootstrap`、`:release` | 0；真实HTTPS、Restic恢复、独立存储key轮换、重建/回退、错误配置与低容量拒绝 |
| `test:backup:oss`、`test:release` | 0；本地OSS/S3兼容TLS及Restic96次请求、OCI摘要加载执行；未访问真实OSS |
| Linux文件/秘密/宿主执行器定向测试 | 0；53/53，无平台跳过 |

本地Restic备份含完整校验6.081秒、恢复命令2.377秒、恢复开始到HTTPS可服务17.150秒；不作为VPS RTO承诺。独立key轮换保持AUTH_SECRET不变，撤销后旧Cookie拒绝，新登录成功。临时CA临期告警按预期保留，没有伪造监控全绿或发送消息。

开发失败记录：最初CAS删除重插方案漏过等待中的原生DELETE，已由短表锁修复并加入确定性回归；首次Linux定向测试命令误用32MiB临时目录，低于既有256MiB门槛而退出1，改用512MiB隔离tmpfs后53项通过，未降低门槛。原始本机日志在项目外保留，秘密目录/备份不上传。

只读复核：`p504_runtime_plan`检查非本人编写的codec/adapter/009及锁顺序；`p504_adapter_research`检查非本人编写的秘密、Compose、恢复、轮换和发布兼容接线；`p504_test_plan`检查新的框架集成断言并推动上述补强。三者均为Agent，尚需负责人协调GitHub正式独立Review。
