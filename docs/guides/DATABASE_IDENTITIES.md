# 为什么不让应用拿数据库 owner 账号

MQ Story 的页面不多，但同一个数据库里放着公开故事、私人草稿、账号、管理员授权和审核记录。如果 Next.js 进程一直拿着初始化数据库的账号，应用中的一次误写就可能变成建表、改权限或重置授权。这里采用的做法是：按工作分配数据库身份，让常驻应用只拿日常请求需要的权限。

这篇是代码导读。完整配置和执行顺序见[生产基础](../engineering/PRODUCTION_FOUNDATION.md)，不需要先读完全部阶段记录。

## 五个登录身份，各做一件事

| 身份 | 用途 | 不应该拿到它的组件 |
| --- | --- | --- |
| `runtime` | 普通认证、草稿、媒体状态、点赞、待审核留言，以及受控的发布和审核函数 | 不交给迁移脚本当作 owner 使用 |
| `migration` | 应用 SQL 迁移，拥有迁移创建的对象 | 常驻应用 |
| `maintenance` | 离线初始化、撤销和维护唯一管理员 | 常驻应用和备份进程 |
| `mediaMaintenance` | 媒体状态恢复与引用核对 | 普通请求处理 |
| `backup` | 读取备份所需的表 | 常驻应用；它也不应拥有写权限 |

角色名称由环境与 deployment ID 派生。连接配置还必须匹配主机、端口、数据库和身份，避免把正确的密码用在错误目标上。一次性的 bootstrap 身份另有高权限，只用于受控初始化与配置，不挂载给应用。

代码从这两处看起即可：

- [database-config.mjs](../../scripts/production/database-config.mjs)：五类身份、部署标记和连接目标校验。
- [database-policy.mjs](../../scripts/production/database-policy.mjs)：每类身份实际得到的表、列和函数权限。这里比文档里的概括更精确。

## 应用有权限，不代表每个用户都有权限

数据库角色限制的是整个应用进程能做什么，账号授权仍由服务端处理。一个普通用户不能因为应用持有 `runtime` 就成为管理员。

管理写操作经过 [`withAdmin`](../../src/server/admin/access.ts)：先验证 Session，再在短事务里确认管理员授权并持锁；业务回调使用同一个事务连接。这样，鉴权和写入之间不会留下“先确认管理员、稍后用另一个连接改数据”的空隙。撤权与密码重置通过数据库约束和锁顺序与这些操作协调，见[管理员设计](../engineering/ADMIN_AUTHORIZATION.md)。

发布和审核也不是直接把状态字段改成 `PUBLISHED` 或 `APPROVED`。应用运行身份没有这些字段的通用写权限，需要调用受控函数，并满足函数内的签名、会话、授权和版本条件。保存草稿因此不会顺手改掉公开版本。

## 为什么还有 11 个不能登录的 owner

部分操作需要窄范围的额外权限。例如 PostgreSQL 的行级共享锁需要相应更新权限，但这不应成为授予应用授权表写权限的理由。项目把这些能力放进 `SECURITY DEFINER` 函数，每个函数使用独立的 `NOLOGIN` owner。

这些 owner 不能直接登录，没有角色成员；函数使用固定 `search_path=pg_catalog`，撤销默认的 `PUBLIC EXECUTE`，再按矩阵授权。它们不是另一个“万能管理员”。当前 11 个 owner 的函数清单在 [database-config.mjs](../../scripts/production/database-config.mjs)，设置和核验在 [database.mjs](../../scripts/production/database.mjs)。

## 权限也是需要测试的配置

空库初始化按 bootstrap → migrate → provision → audit 执行。迁移处理结构，provision 配置当前权限矩阵，audit 用运行身份核对真实权限；不能只看迁移退出 0 就认为应用身份正确。

应用启动和健康检查还会检查部署标记、角色属性、函数 owner 与授权。发现漂移时拒绝继续运行，不自行扩大权限修好自己。这也解释了为什么本地默认的高权限开发账号不能直接用于完整后台。

相关验证入口是 `npm run test:production:db`；管理员业务路径另见 `npm run test:admin`。两者都只应运行在各自的隔离测试目标上，前置条件见[开发指南](../DEVELOPMENT.md)。

## 值得借鉴，也有代价

可以借鉴的是身份分工、同一事务内授权和写入、权限矩阵与实际审计。角色数量本身不是质量指标：每增加一个业务函数，都需要同步迁移、权限配置和测试，初始化也比单账号方案复杂。

这些限制减少应用身份的能力范围，不能约束数据库 superuser、宿主机 root，或证明任意 SQL 写入后所有数据仍可信。Session 的加密与完整性边界有单独设计，见 [SESSION_STORAGE.md](../engineering/SESSION_STORAGE.md)。

[返回文档索引](../README.md)
