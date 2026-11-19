# Better Auth 1.7.12：Session Token 存储实验

**P5-04更新**：负责人选择正式上线前改造。实际应用接入独立认证加密及查询索引，见[Session安全存储](../engineering/SESSION_STORAGE.md)。以下原值／摘要路径是保留的历史负面实验，使用独立001–008模型，不再描述当前应用；009拒绝旧格式及摘要即bearer。

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

## P5-02 上线前复核（2026-11-07）

重新读取安装的 1.7.12 源码和当前官方文档，结论保持：**当前生产代码仍原值存储 Session Token，摘要候选不得接入。** 当前官方 [会话合同](https://better-auth.com/docs/concepts/session-management) 仍将 token 用于列表及逐个撤销；[adapter 扩展](https://better-auth.com/docs/guides/create-a-db-adapter) 允许替换数据库操作，但不会自动改变上层会话语义。没有发现适用于锁定版本的内置单向存储选项。`customSession` 修改响应，Cookie 加密修改客户端缓存，均不能替代数据库 token 设计。

新增真实 PostgreSQL/HTTP 对照后，`npm run test:auth:session-spike` 在 Windows、Node 24.19.0、PostgreSQL 18.6 上 **15 组通过，退出 0**；本次随机库完成正式迁移，测试结束已删除本次随机库，未修改既有开发库。源码摘要仍由脚本输出，便于升级后比较。新增检查包含：

| 路径 | 默认框架实测 | 摘要候选实测 |
| --- | --- | --- |
| 列出会话 | 仅当前账号的有效会话；过期设备不返回 | 列表只有摘要，无法还原各设备 token |
| 单个撤销 | 使用列表 token 后目标 Cookie 失效；其他设备仍有效 | HTTP 200，但目标仍有效，不得以响应成功作为撤销证据 |
| 仅撤销其他设备 | 其他设备失效，当前设备保持有效 | 列表摘要与当前原 token 不同，比较及逐个删除均错配；两条记录都仍在 |
| 全部撤销 | 当前设备也失效，其他账号不受影响 | 按 userId 删除正常；这不能补偿上面两项缺陷 |
| 越权及匿名调用 | 匿名列表/撤销 401；提交另一账号 token 不会删除对方会话 | 不通过放宽查找规则修复兼容性 |

另加入只存在于隔离脚本的**不安全反例**：遇到 `sha256:` 前缀就跳过摘要计算，确实可以让查找匹配数据库值，但把该数据库摘要签成 Cookie 后也能登录。它重新使数据库值成为可用凭据，丢失摘要存储的目标。测试明确验证这个危险结果，不将其作为推荐修复；实际应用没有引入该分支。

MQ 公共 HTTP 合同仍只有注册、用户名登录、读取当前会话和退出四条路径。`/list-sessions`、`/revoke-session`、`/revoke-other-sessions`、`/revoke-sessions` 均被同一白名单拒绝，认证 HTTP 套件补齐后两条的断言。当前产品没有“查看设备并逐个退出”的界面；管理员维护撤销/重置及离线全量会话撤销已有独立权限和测试，不能把框架实验端点宣称为网站功能。

### 本轮处置及开放门槛

- 不改实际认证、Schema 或历史迁移，不增加原值/摘要混合读取；保留官方框架的已验证行为。
- 维持 24 小时会话、关闭 refresh 与 Cookie cache；退出、管理员撤权/重置、受控全量撤销及恢复清除旧 Session 必须继续实测。
- 严格 HTTPS、签名 HttpOnly/Secure/SameSite Cookie、Origin/CSRF、数据库最小权限及加密备份是补偿控制，**不等于 token 已摘要化**。数据库与认证 secret 一并泄漏或整个应用主机失陷时，残余风险仍高；备份密码与正式认证 secret 不能和备份副本一起存放。
- 正式用户开放前，要么交付经独立审查的完整存储/会话句柄方案，要么由负责人在独立安全审查后明确接受有期限的残余风险；没有该决定时继续阻止正式开放。不能在部署自动化中用“Spike 通过”代替这个门槛。
- 若后续实施摘要方案，需覆盖所有原生会话方法、受支持插件、事务/刷新/过期/恢复和升级合同；维护窗口撤销现有会话后切换，禁止摘要即 bearer 的兼容捷径。可逆加密虽能保留列表语义，但还需独立密钥、认证加密和查询索引，不能未经验证临时替代。

此次还核对了现有密码成本：Node scrypt 的 `N=32768,r=8,p=3` 属于 [OWASP 列出的等效配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)，执行容量仍限制为并发 2、队列 4。这只验证配置与现有实现，不是正式 VPS 的暴力攻击容量承诺。框架升级或开放新的认证插件前必须重新运行本 Spike 与完整认证/权限回归。

## P5-03：明确数据库泄露的不同边界

2026-11-08 重新核对锁定源码、官方会话、adapter、配置和安全文档，仍没有找到适用于 Session 的内置单向存储开关。Magic Link / One-Time Token 的 `storeToken` 配置不适用于当前 Session；当前 MQ 也未启用这些插件。本轮保留原值存储，未修改认证协议、Prisma Schema 或 001–008。

| 威胁 | 实际影响与当前边界 | 处置与剩余风险 |
| --- | --- | --- |
| 仅取得数据库只读副本 | 获得原 token、密码摘要和私有数据；单独原 token 不能构造当前路径接受的签名 Cookie。签名保护不等于副本无敏感内容 | 数据库入口隔离、最小权限、Restic 加密及秘密分开保存；按泄露处置撤销会话、轮换相应凭据。已泄露内容无法撤回 |
| 取得运行身份的任意 SQL 写能力 | Session INSERT/DELETE 可将攻击者自己的合法签名 Cookie 重新绑定到另一个 userId。Cookie 签名只绑定 token，单向存储也不保护身份映射 | SQL 写身份是认证信任边界，不能仅靠 Token 摘要或 AdminGrant 不可写宣称抵御。必须保护运行凭据、参数化查询和私有网络；失陷时关闭入口、撤销会话并在可信环境恢复 |
| 窃取已签名 Cookie | 有效期内可以重放；HttpOnly 防止一般脚本读取，不能阻止浏览器/终端失陷后的盗取 | HTTPS、Secure/HttpOnly/SameSite、无 Cookie 缓存与 24 小时有效期；主动撤销立即失效。Origin/CSRF 防跨站操作，不是被盗凭据的替代保护 |
| 应用主机或认证秘密与数据库一同失陷 | 可签造 Cookie、读取私人内容并行使应用本身的权限；摘要存储也不能补救整机控制权泄露 | 视为高风险事件，从可信控制通道隔离和恢复；撤销旧 Session、轮换独立秘密后重新验收。不能只在原机换一个 Token 字段就恢复开放 |

上述第二类是明确的信任边界，**不是已经发现 MQ 存在 SQL 注入**。`database-policy.mjs` 为注册/退出保留 Session SELECT/INSERT/DELETE；运行身份没有该表 UPDATE，也无 AdminGrant 写权，但这不足以保护任意 SQL 写入后的会话身份。备份专用身份只读，不能与这类写入失陷混为一谈。

Spike 新增隔离反例：分别以默认原值与摘要候选注册两个合成账号，创建仅有 Session SELECT/INSERT/DELETE 的临时 NOLOGIN 角色，在该角色下删除自己的记录并插入相同 token、另一 userId 的记录；不使用目标 Cookie、认证 secret 或 Session UPDATE。真实 HTTP 随后接受原来的签名 Cookie 并返回另一合成身份。临时角色创建、授权、操作与撤销在一个事务中，失败整体回滚；正常结束删除本次随机库。测试刻意验证风险仍然存在，不能把这一项 PASS 解读为风险已消除。

本轮定向验收保留此前 15 组，新增上述一组。Windows / Node 24.19.0 / PostgreSQL 18.6 执行 `npm run test:auth:session-spike`：**16 组通过，退出 0，随机库清理完成**。登录、多设备列表、单个/其他设备/全部撤销、退出、过期、事务回滚、密钥轮换及 Cookie 回滚拒绝仍为真实 PostgreSQL/HTTP 测试。完整备份恢复时清除 Session 与发布/审核签名密钥由 `restore.mjs` 和容器恢复套件验证，不在这个框架 Spike 中重复实现。

生产开放仍需负责人作出明确决定：在独立安全审查后接受有期限的原值存储残余风险，或先批准完整的存储与会话句柄整改。可逆认证加密加查询索引可能保留列表语义，但涉及独立密钥、迁移、全部 adapter 方法和恢复合同，尚未实现或验证。本报告没有作出生产风险接受决定，也不授权开放注册。
