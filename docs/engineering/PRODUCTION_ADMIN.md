# 部署环境的管理员维护

P5-02 增加 `scripts/production/admin-cli.mjs`，不改变 P2-05 的授权模型或历史迁移。旧 `scripts/admin/maintain.mjs` 仍仅用于本地数据库；`lab-actions.mjs` 仍仅用于合成 staging。真实生产账号不能使用实验初始化入口。

本轮只实现工具，并以随机隔离数据库和合成账号验证。没有创建正式管理员、生成正式密码或启用业务开关。首次正式使用仍需负责人批准目标、操作和维护窗口。

## 运行边界

- 只使用对应发布候选的 `tools` 镜像，UID10001；不在应用容器中挂载维护凭据。
- 配置由 `MQ_DEPLOYMENT_CONFIG` 指向不可写外部 manifest，连接由 `MAINTENANCE_DATABASE_URL_FILE` 指向 0400/0600 外部秘密文件。不接收连接串、密码参数或原始密码环境变量。
- 每次核对数据库名、PG18、部署标签、登录身份及派生的 maintenance 角色，再使用既有完整权限矩阵检查。超级用户、runtime、migration、错误部署和权限漂移均拒绝。
- `init`、`revoke`、`restore`、`reset-password` 必须在交互 TTY 执行。生产还要求精确 `--confirm-production=<deploymentId>`，并在终端逐字确认操作、部署 ID 与目标账号。
- `init`/`reset-password` 只在原生终端隐藏输入两次密码；不支持管道、密码文件、fixture 或环境密码输入。JavaScript 字符串不能保证内存清零；宿主 root 与运维终端仍是可信边界。
- 命令不自动开放认证、发布、图片或留言开关，也不修改域名、代理或公网端口。

## 操作

先在审核过的一次性 Compose override 中，只给 `tools` 挂载当前 manifest 和 maintenance 连接文件。保留无宿主端口、只读根文件系统、数据库私网、UID10001 和资源限制。命令中的 ID、用户名、版本均为非秘密目标标识；密码始终在交互提示中输入。

```sh
# 只读检查当前管理员身份和授权版本。没有授权时返回 initialized:false。
docker compose ... run --rm --no-deps tools scripts/production/admin-cli.mjs --operation status

# 必须使用交互终端，不能加 -T；bootstrap 不代替此显式维护操作。
docker compose ... run --rm --no-deps tools scripts/production/admin-cli.mjs \
  --operation init --username <approved-dedicated-name> --confirm-production=<deploymentId>

# 用 status 得到的精确 userId/version；不是用户名或内部邮箱判断权限。
docker compose ... run --rm --no-deps tools scripts/production/admin-cli.mjs \
  --operation revoke --user-id <verified-uuid> --expected-version <current-version> \
  --confirm-production=<deploymentId>
```

`restore` 和 `reset-password` 使用与 `revoke` 相同的目标参数。staging 不接受生产确认参数，避免混淆环境。所有写操作使用现有领域事务、乐观并发控制及数据库触发器：

| 操作 | 结果 |
|---|---|
| init | 新建专用普通认证账号及唯一 AdminGrant；重复或第二账号初始化拒绝，失败不留 User/Account |
| revoke | 撤销授权，删除该账号全部 Session，保留账号及不可变授权绑定 |
| restore | 恢复同一个账号授权，删除已有 Session；不能借此转移管理员 |
| reset-password | 替换密码哈希，推进授权/凭据版本，删除全部 Session；若授权已撤销，仍保持撤销 |

版本冲突、取消输入或数据库异常返回非零。未知写入结果不能盲目重试；先通过 `status` 和受控审计记录核对。共享管理员只能按账号/数据库身份审计，不能据此识别实际使用者。

## 验证入口

`node --test tests/production-admin.test.mjs tests/admin-terminal.test.mjs` 验证参数、目标、无回显/取消和管道拒绝；`tests/production-admin-pty.test.mjs` 在 Linux 的真实伪终端中执行命令的确认与隐藏输入，数据库为固定测试替身，不冒充数据库验收。

`node scripts/production/admin-tests.mjs` 仅通过既有 `mq_test` 防护创建随机 staging 数据库，执行 001–008 和全部身份配置，再验证真实管理员初始化、重复拒绝、撤销/恢复/重置、Session 失效、CAS 和权限漂移。结束只清理自身随机测试数据库与角色，不接管或清空开发库。

`npm run test:production:bootstrap` 使用随机 Docker 项目和独立 PostgreSQL 集群，实际运行 `environment=production`、`mq_production` 与 8 GiB 余量合同。首次 bootstrap 验证 User、Story、AdminGrant 均为空；之后仅测试 fixture 通过同一管理员维护函数创建合成身份。真实 HTTPS 验证登录、授权撤销及旧 Cookie 失效，恢复到另一个独立集群后重新验证权限和 Session 清除。fixture 不替代正式 CLI 的交互输入，也不会创建正式管理员。TLS 使用仅绑定回环的临时 CA，不代表正式公网证书已验收。
