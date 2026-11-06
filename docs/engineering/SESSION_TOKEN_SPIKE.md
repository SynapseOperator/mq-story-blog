# Better Auth 1.7.12：Session Token 存储实验

本实验属于 P3-03 / Issue #51，最初以 PR #50 的 `052fbc4` 为实现基线；#50/#52 后续均已合并。**结论：本轮不把摘要 adapter 接入应用。** 真实 HTTP 和 PostgreSQL 测试证明，当前 MQ 使用的基础认证路径能够适配摘要，但框架的会话列表和逐个撤销语义不能直接兼容。没有修改认证业务代码、Prisma Schema 或 001–008 迁移。

## 当前实际行为

以 `package-lock.json` 安装的代码为准；线上文档可能更新，不能代替 1.7.12 的源码：

| 代码接点 | 已核实行为 |
|---|---|
| `@better-auth/core/dist/utils/id.mjs`、`@better-auth/utils/dist/random.mjs` | Session 使用 32 位字母数字随机串，随机源为 `crypto.getRandomValues`；约 190 bit 随机空间，不是密码派生值 |
| `better-auth/dist/db/internal-adapter.mjs` `createSession` | `generateId(32)` 放进 session.token，随 Session INSERT 原值写入数据库 |
| 同文件 `findSession` | 用 token 等值查询并联结 user；Session 缓存关闭时每次都读数据库 |
| 同文件 `updateSession` / `deleteSession` / `deleteSessions` | 按 token 进行 UPDATE / DELETE；按用户撤销则使用 userId |
| `better-auth/dist/cookies/index.mjs` `setSessionCookie` | session.token 经 Cookie 签名送到浏览器。签名提供完整性，不改变数据库存储形式 |
| `better-auth/dist/api/routes/session.mjs` | 先验证签名 Cookie，再查询数据库及到期时间；刷新、过期清理继续使用查出的 token |
| `src/server/auth/service.ts` | MQ 关闭 Cookie 缓存及自动 refresh、会话有效期 24 小时；公开响应删除原始 token/内部邮箱；HTTP 白名单不开放 list/revoke 系列端点 |
| `src/server/admin/access.ts` 与 004/006/007/008 SQL | 服务端先取得有效身份，事务内用 Session.id/userId 再查有效期/管理员授权。函数不按 token 查找；Session.id 不是 bearer |

数据库只读泄露会暴露随机 token，但仅该值不能在现有 MQ 签名 Cookie 路径直接冒充用户，还需要有效 Cookie 签名。不能因此认为原值存储安全：token 与认证秘密、已签名 Cookie 或未来其他接受 bearer 的入口一同泄露时风险明显扩大。管理员/运维、备份、日志及主机权限仍是必要边界。

## 官方扩展与本次实验

官方允许通过 `database` 提供 DBAdapter，并提供 `createAdapterFactory`；支持 create/find/update/delete、joins 和 transaction 等合同。本实验仅包装公开 `prismaAdapter` 返回的 DBAdapter，并在事务回调内继续包装其 TransactionAdapter；没有修改 node_modules、调用 `auth.$context.internalAdapter` 或绕过框架签名检查。[官方 adapter 指南](https://better-auth.com/docs/guides/create-a-db-adapter)

已读 1.7.12 的 session 配置和运行源码，未发现内置 Session Token 单向存储开关。verification token/OTP 存储选项、OAuth token 加密和 Cookie 缓存策略不能作为 Session.token 的替代开关。官方会话文档描述列表、撤销和缓存生命周期，因而不能只以登录成功宣布完整兼容。[会话管理](https://better-auth.com/docs/concepts/session-management)

三条对照路径使用同一份随机隔离数据库、正式 001–008 迁移及真实 Prisma：

1. **默认 adapter**：数据库 token 与 Cookie 内 bearer 相等；缺少签名的 token Cookie 被拒绝。
2. **仅 session.create.before 做 SHA-256**：框架把修改后的值写库并签成 Cookie，结果仍是 DB 值 = bearer。此方案不能解决 at-rest 分离。
3. **公开 DBAdapter 包装候选**：INSERT 存 `sha256:<digest>`，确切 token 条件查询先摘要，create/find/update 的返回对象恢复该次请求已持有的原 token，不在服务器缓存或另存原 token。真实注册、用户名登录、联结读取、刷新、退出、到期删除、按 ID 撤销及按 userId 全量撤销通过。摘要本身即使被实验密钥签成 Cookie 也被拒绝；没有“已经是摘要就直接接受”的分支。

**阻塞复现**：按 userId 调用 `/list-sessions` 时数据库仅有摘要，不能恢复各设备原 token。把列表中的摘要交给框架 `/revoke-session` 会再次摘要，返回 `{status:true}` 却没有撤销原会话；`/revoke-other-sessions` 也存在相同错配。测试把这个缺陷作为预期观察结果验证，不把 HTTP 200 当作撤销成功。虽然 MQ 当前白名单未开放这两个端点，启用候选仍将形成隐含的框架限制，后续插件/功能很容易误用。

候选只是隔离实验，不能直接 import 到应用，也不应以服务端保存原 token 映射或接受摘要作为 bearer 的方式补洞。其他插件、secondaryStorage、OAuth、跨节点 Cookie cache 并未验证，不能宣称全面支持。

## 实际验证与复现

```sh
npm run db:generate
node scripts/auth/session-token-spike.mjs
```

脚本仅通过既有 `databaseUrl("test")` 接入 `mq_test` 测试控制实例，新建随机 `mq_test_auth_<uuid>` 库；不迁移或清空已有开发/测试库。真实 loopback HTTP 服务使用合成账号，保留 Origin 与签名检查，实验限流仍启用。输出仅含检查名、统计、版本及依赖源码 SHA-256；不输出 Cookie、token、密码或内部邮箱。结束先关服务/Prisma/Pool，等待本次数据库连接归零后正常删除该随机库，不 FORCE DROP。

2026-11-06 Windows / Node 24.19.0 / PostgreSQL 18.6：**11 组检查通过，退出 0**。覆盖：

- 默认原值存储与签名 Cookie，create hook 无保护收益。
- 摘要候选真实 create、findOne + user join、update、delete、findMany、deleteMany。
- 刷新不把摘要写回 Cookie；退出、过期清理、ID 撤销立即失效。
- 管理员授权初始化先撤旧会话，再登录后原 Session.id 权限函数正常；不改变管理员授权结构。
- 真实会话 INSERT 后抛错，注册事务中的 User、Account 和 Session 均回滚。
- 列表/单个撤销/其他设备撤销的兼容缺陷可重复复现。
- 原值旧会话切到候选后拒绝，数据库记录不被静默改写。
- 更换 AUTH_SECRET 后旧 Cookie 拒绝，新密码登录成功；全量删除 Session 后，即使切回旧 secret 也不能恢复旧 Cookie；外站 Origin 请求拒绝。

本次不是 MQ 全站生产安全验收。实验为框架回归刻意开启 refresh 以覆盖 UPDATE 路径；实际应用仍关闭 refresh。实验调用的框架原生注册/列表端点只存在随机 loopback 服务，未接入项目路由。Linux CI 应运行同一脚本，最终结果以该 PR 的对应提交为准。

## 轮换、迁移与后续选择

**认证 secret 轮换**：1.7.12 的 `get-session` 和 `sign-out` 验签使用单一 `ctx.context.secret`。官方多版本 secret 文档主要说明加密数据的版本化解密，不能据此承诺 MQ 已签名 Cookie 无缝过渡。本轮实验验证的是短维护窗口、撤销 Session、换文件、重启后重新登录；具体运维见生产操作手册。[官方安全与 secret rotation](https://better-auth.com/docs/reference/security)

**若未来批准摘要化**：需要明确版本合同、新增迁移或维护转换流程、所有 adapter 方法与插件的验收及独立安全 Review。最简单的切换是维护窗口撤销全部旧 Session，切换后统一重新登录，避免原值/摘要双读长期共存；目前没有执行此转换。历史迁移不改。权限函数继续按 Session.id，但备份恢复、管理员凭据重置及低权限测试都需要完整重跑。

可选后续路线：

- 优先寻求官方 token 存储/会话句柄合同，或经独立审查的完整 adapter 与撤销协议；当前实验不证明“框架绝不可能支持”，只证明简单包装不可直接交付。
- 独立密钥的可逆加密可以保留列表语义，但需要 nonce/认证加密、查询索引、密钥管理与恢复迁移，风险和改动明显大于本轮 Spike，尚未实现或验证。
- 现阶段保留现有认证，依靠低权限、数据库/加密备份访问控制、严格 Cookie、受控启用和故障撤销降低风险。是否允许真实用户开放仍需负责人风险决定和独立安全审查，不能把本报告视为已修复原值存储。

没有真实账号、正式密钥或生产数据库参与；不因 Spike 通过而开放注册。
