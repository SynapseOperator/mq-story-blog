# 私有数据库与图片备份恢复

P2-09D 使用 PostgreSQL 原生 `pg_dump`/`pg_restore` 和本地私有目录。它是小规模项目的受控维护方案，不引入云服务、定时清理或后台队列。只备份数据库及 READY 素材的展示图、缩略图，不长期保存上传原图。

## 一致性和权限

备份维护连接开启 REPEATABLE READ，先取得 `media_asset` 的 SHARE 表锁，再导出快照。清单查询和 `pg_dump --snapshot` 使用同一快照；锁保持到图片复制、原生数据库导出和完整性验证完成。该锁阻止媒体 INSERT/UPDATE，包括 READY→DELETING；READY 文件不可原位覆盖，因此不会发生数据库备份引用了复制前已被删除的图片。

存在 PENDING 或 DELETING 时直接拒绝备份。先停止上传/删除的应用进程，并完成受控恢复后重试，不能仅靠“没有人在点击”保证没有在途操作。FAILED/DELETED 记录仍在数据库备份内，残留文件不属于可恢复图片清单；不会把未知文件一起复制。故事更新可继续发生，但导出快照固定，数据库内容、Revision 关系和素材清单对应同一时点。建议整个操作在停服维护窗口执行，避免长时间阻塞写入；锁等待上限 5 秒，单次 PostgreSQL 工具、数据库语句及事务空闲超时为 5 分钟；这不是整个备份流程的硬时限。数据库 dump 上限 512 MiB。超出当前规模应另行设计。

文件 I/O 不占用 `withAdmin` 权限事务。备份使用单独的本地 owner/维护连接，不使用运行时账户，也不自动授予任何新权限。它不是允许网站运行时读全库的接口。

每次备份新建 `mq-backup-<uuid>`，不会覆盖既有目录。Linux 目录/文件为 0700/0600；Windows 新备份目录移除继承，仅当前用户、SYSTEM、本机 Administrators 有访问权限，后续读备份时检查有效允许项。只修改本次新子目录的 DACL，不改系统策略或已有根目录。Windows PowerShell 子进程使用自身模块路径，不继承 PowerShell 7 的 `PSModulePath`。

备份包含内部邮箱、密码哈希、故事正文及可能仍有效的原值 Session Token。应用 006 后，完整数据库归档还包含 `mq_publish_private` 的发布签名密钥；不能将备份当作普通测试产物。备份根必须在 Git、项目/public 之外；不得上传 GitHub CI Artifacts、邮件、公开网盘或调试日志。持有同一 OS 管理权限的攻击者不在文件 ACL 的防护范围内。当前没有加密归档、签名、异地备份或防勒索能力，正式环境还需磁盘加密、存储访问控制和独立安全审查。

## 操作

先通过操作者自己的秘密管理方式设置进程环境，不将连接串写到命令行、仓库或粘贴到日志：

- `MQ_MEDIA_BACKUP_DATABASE_URL`：显式本地维护连接；不自动读取 `.env.db.local`。
- `MQ_MEDIA_BACKUP_PARENT`：已存在、Git/public 外的备份父目录。
- `MQ_MEDIA_ENV`、`MQ_MEDIA_DEVELOPMENT_ROOT`、`MQ_MEDIA_TEST_ROOT`：与当前私有存储配置一致。
- `MQ_PG_TOOLS_CONTAINER`：可选，已存在的官方 PostgreSQL 18 容器名/ID。Windows 验证使用现有 `mq-story-blog-postgres-test-1`；不启动或重建容器。未设置时使用 PATH 中 PostgreSQL 18 客户端。

以下是交互式命令，`mq_test` 为本轮合成演练目标示例；脚本要求终端逐字确认，拒绝无人值守管道和多余参数：

```sh
node scripts/media/backup-cli.mjs backup mq_test
```

Docker 模式通过 stdin 传递密码，原生工具通过子进程环境传递；均不把密码放入 argv。工具 stderr 不进入应用/CI 日志。输出只有完成状态、数量和给本地操作者使用的随机备份目录。

完整备份包含 `database.dump`、`manifest.json`、`media/<storageKey>/{display,thumbnail}.webp` 和最后写入的 `COMPLETE.json`。清单记录素材 ID、数据库状态、尺寸、字节数和 SHA-256。只有所有步骤成功且数据库事务结束后才写 COMPLETE；失败的目录保留以供定点诊断，不自动删除。不能只检查标记文件存在，必须执行完整验证：

```sh
# 先设置 MQ_MEDIA_BACKUP_DIRECTORY 为刚才的私有备份目录
node scripts/media/backup-cli.mjs verify mq_test
```

校验包括文件集合、缺失/多余文件、路径和权限、真实 WebP 尺寸、字节数及哈希、dump 和清单哈希。恢复后再把清单与数据库记录集合逐项比对。哈希能发现意外损坏或未同步修改；**不能验证同时改写 dump、清单与哈希的攻击者**。仅恢复来源可信且访问受控的备份；原生数据库归档本身可能包含可执行 SQL。

## 隔离恢复演练

首版只允许恢复到本机 `mq_test` 控制实例中新建的随机 `mq_test_admin_<uuid>` 数据库，以及新 `mq-restored-media-<uuid>` 私有目录。没有覆盖已有库/目录、切换生产或启动服务的命令。

设置 `MQ_MEDIA_RESTORE_CONTROL_URL`（本地 mq_test 身份和实例）、`MQ_MEDIA_RESTORE_PARENT`（私有恢复父目录）及 `MQ_MEDIA_BACKUP_DIRECTORY` 后：

```sh
node scripts/media/backup-cli.mjs restore mq_test
```

使用 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`。恢复库首先撤销 PUBLIC CONNECT；导入后撤销所有非系统 Schema 的 PUBLIC Schema、表、序列和函数权限，包括 006 的 `mq_publish_private` 及 pgcrypto 函数，避免恢复扩展后留下默认 PUBLIC EXECUTE。不会复活旧部署角色或把维护身份当作应用身份。只有数据库清单和文件验证全部成功才生成 `RESTORE_COMPLETE.json`；失败时删除本次新建的隔离数据库，保留无完成标记的私有诊断目录。

恢复后 **不能直接开放服务**：需要在隔离库重新应用既有管理员、草稿与媒体权限配置，以受限 runtime/maintenance 身份做 HTTP/HTTPS 验证。上述配置不授予发布权限；原签名密钥和原 Cookie 即使仍匹配，也不能自动启用发布。恢复后的发布函数 owner 是恢复身份，不满足 006 的受限 NOLOGIN 所有者检查，误授 EXECUTE 仍会拒绝。恢复工具不配置发布 owner、不轮换或重用密钥来开放服务。

正式切换之前须明确密钥轮换、会话撤销及权限重建策略；归档确实保留当时的签名密钥和可能有效的 Session Token，脚本不会暗中改变归档数据冒充完整恢复。最终生产切换、旧库处理、密钥和角色配置均不在本轮授权内。

## 自动化证据

`scripts/media/backup-tests.mjs` 使用随机隔离库、合成 WebP 和随机临时私有目录，真实执行全部历史迁移及 native dump/restore。覆盖 PENDING/DELETING 拒绝、同快照和真实删除锁等待、失败不产生完成标记、缺失/损坏/篡改、独立恢复数据库清单比对、Session 合成 token 还原、PUBLIC 函数权限撤销。联合 runner 通过 `verifyRestored` 回调重配低权限身份，再启动生产构建 HTTP/HTTPS 验证公开图片 200、私人图片 404、未授权管理员读取 401/403。

P2-09D 的 Windows 首轮发现并修复：测试库前缀不符合既有日志隔离白名单；PowerShell 5 子进程继承 PowerShell 7 模块路径导致 ACL 模块加载失败。修复仅调整测试命名和子进程环境，未降低 ACL 检查或修改系统配置。该阶段 Windows 独立备份/恢复 7/7 已真实通过；[PR #36](https://github.com/SynapseOperator/mq-story-blog/pull/36) 已合并，main [CI #41812969659](https://github.com/SynapseOperator/mq-story-blog/actions/runs/41812969659) 的 quality/database 成功。

P2-10A 同步增加 `scripts/publishing/backup-tests.mjs`，Windows 真实执行 6/6 通过，覆盖非空签名 Schema 与 Session 的完整恢复、非系统 Schema 的 PUBLIC 权限清除、原运行身份连接拒绝、普通权限配置后的密钥隔离与 HTTPS 发布拒绝，以及有效旧密钥签名下的 owner 检查。完整回归与 Linux CI 记录在 PR #38 的对应提交；不以原 P2-09D 结果代替 006 的联合恢复验收。

官方依据：[PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)、[导出快照](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)、[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)。
