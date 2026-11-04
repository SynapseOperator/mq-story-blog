# 素材删除与定点恢复

对应 [Issue #35](https://github.com/SynapseOperator/mq-story-blog/issues/35)。基于 main `1850610`，不改历史 001→005、不增加发布或上传协议，也不改变现有编辑器和羽毛信。

## 删除

`DELETE /api/admin/media/[id]` 要求有效管理员 Session、既有 Origin 检查，以及 `x-mq-confirm-delete: <同一个素材 UUID>`。不接收 body、查询参数、storageKey 或路径。首版只有接口，没有批量删除或新增删除 UI；调用者必须先明确确认永久删除该素材。

1. `withAdmin` 同一事务内锁住素材行，检查历史引用，转为 DELETING。
2. 事务外删除固定 `display.webp`、`thumbnail.webp` 和 `.pending-UUID`，先检查整个对象目录；遇到未知文件、目录或链接，全部拒删。不递归删除根目录。
3. 再次 `withAdmin` 后转为 DELETED。文件失败、进程中断、撤权或数据库故障时保留 DELETING，授权管理员可重试；DELETED 响应幂等。

在线仅删除 READY 或源于 READY 的 DELETING。PENDING/FAILED 可能仍有旧上传进程写文件，交由停止所有写入进程后的离线维护。

任意历史 Revision（包括下架故事或旧公开版本）引用都阻止删除。005 的 `(assetId, READY)` 外键及键锁保证并发新引用不会绕过检查；没有删除引用或改写历史 Revision 的接口。删除不影响其他素材或故事。

响应仅现有安全素材 DTO 或固定错误码：401/403 权限拒绝；400 缺少确认或非法请求；404 无记录；409 历史引用或不允许的状态；503 文件/数据库故障。所有响应 no-store，无内部路径和驱动错误。

## 离线维护

使用受控、独立的本地媒体维护数据库角色。部署负责人先显式调用 `applyMediaMaintenancePrivileges(pool, { maintenanceRole, expectedDatabase })` 配置预建角色；不是应用启动步骤，也不会创建或升级角色。角色只读 media_asset/story_revision_asset，并仅可更新素材 state/updated_at；不能读账号、改 metadata、历史引用、管理员或发布状态。CLI 会核验实际权限，拒绝 owner、应用角色及已有管理员凭据维护角色。

连接串只通过 `MQ_MEDIA_MAINTENANCE_DATABASE_URL` 注入进程环境，不放命令参数或日志。不自动读取 `.env.db.local`。沿用 `MQ_MEDIA_ENV`、`MQ_MEDIA_DEVELOPMENT_ROOT`、`MQ_MEDIA_TEST_ROOT` 私有目录配置。这里只允许明确端口的回环数据库，不操作生产环境。

```sh
npm run media:maintain -- --operation diagnose --database <数据库名> --asset-id <素材UUID>
npm run media:maintain -- --operation recover --database <数据库名> --asset-id <素材UUID>
```

`diagnose` 只返回素材 ID、状态、历史引用数，以及两种派生文件的 ok/missing/mismatch/untracked/unsafe 状态，不输出路径、Key 或图片内容。这是时点诊断，不是长期一致性保证。

`recover` 必须在停止所有使用该数据库和卷的应用/上传进程后，通过 TTY 输入 `RECOVER <数据库名> <素材UUID> OFFLINE`。仅处理过期 PENDING（120 秒）、FAILED、DELETING 或 DELETED 残留；READY 一律拒绝。处理仍分为事务状态变更、事务外定点清理、事务收尾。失败可再次运行；未知文件保持原样，先人工调查，不能用全盘清空解决。

这是已知资产的定点恢复，不是存储根目录的自动孤儿扫描器。无数据库记录的未知文件不猜归属、不自动删除。进程停止是操作者必须满足的前置条件，CLI 不能证明其他主机已停止写入。

## 验证与限制

`npm run test:media:lifecycle` 使用随机隔离 PostgreSQL、专用测试身份和私有临时目录，验证删除/引用两种锁顺序、历史引用、回滚、真实服务器中断、确认与权限、维护角色越权，以及联合备份恢复。需先 `npm run check` 生成生产构建；运行不会改开发库或清空 mq_test。

原有测试与 CI 全部保留，新增生命周期检查；数据库 Job 上限由 20 分钟扩为 30 分钟以容纳真实恢复演练，没有跳过失败。测试通过不等于正式安全审查通过。

2026-11-04 Windows 本机真实结果（Node 24.19.0 / PostgreSQL 18.6 / Prisma 7.10.1）：

| 检查 | 结果 |
| --- | --- |
| `npm run check` | lint、Schema、类型、生产构建；142 单测中 140 通过，2 项既有 Windows 文件 symlink/POSIX mode 限制 |
| `test:media:lifecycle` | 6 DB + 7 离线维护 + 10 HTTPS 删除 + 7 native 备份恢复组；保留基础上传、权限和 HTTPS 检查；退出 0 |
| 既有回归 | test:db、test:auth、test:admin、test:admin-drafts、test:admin-editor、test:admin-preview、test:media、test:media:upload、test:media:stories、test:public 全部退出 0 |
| 生产浏览器 | 桌面1536×1024、390×844、320×568、触屏和 reduced-motion；编辑器、私有预览、v1/v2 图文、分享及草稿保护回归通过，未改 UI |

首轮维护权限查询对普通表调用了序列权限函数（42809），现用按关系类型分支的 CASE 修正并实际验证权限不变。第二轮测试误把 RESTRICT 错误写成23503，按真实 PostgreSQL 精确改为23001；新引用 FK 失败仍验证23503。原始失败日志保留在本地验收目录，未删除或跳过对应测试。Linux 完整 CI 链接及准确提交见 PR。

备份含认证数据和可能有效的 Session Token，不能上传 CI Artifacts。操作与一致性限制见 [MEDIA_BACKUP.md](MEDIA_BACKUP.md)。生产角色、私有卷 ACL、磁盘硬配额、HTTPS/可信代理、日志与备份访问及独立安全审查仍为开放门槛。本轮不部署，不自动合并，不开发 P2-10。
