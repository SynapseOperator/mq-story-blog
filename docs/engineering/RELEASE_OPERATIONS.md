# P4：发布候选与受控更新

关联 Issue #53。本轮实现已审核 main 的手动候选构建、OCI 完整性验证和合成环境更新/回退演练。没有连接 VPS、配置域名、上传服务器凭据或执行生产部署。实际 VPS 的 CPU 架构尚未核验；首版产物只支持 **linux/amd64**，不能据此假定服务器兼容。

## 候选从哪里来

`Release candidate` 只接受 `workflow_dispatch`，不响应 push，不调用 SSH，不持有运行秘密或 GHCR 凭据。工作流从 main 执行，`source_sha` 必须是 40 位、已合并 main 的提交；允许选择历史 main 祖先作为回退候选。

构建前、归档前各读取一次 GitHub：核实 main 祖先关系、对应合并 PR、SnorkelingBreather 对最终 PR HEAD 的独立 APPROVED、任何评审者未撤销的 CHANGES_REQUESTED、未解决线程，以及目标 SHA 最新 Quality 的 quality/database/container 三 Job 全部成功。输入确认文本不能代替这些查询。CI 取消、待运行、缺 Job、跳过或失败均拒绝。

GitHub 当前环境列表为空。官方说明：Pro/Team 的私有仓库可以有 Environment 和 secrets，但 required reviewers 等部署保护对这些套餐仅支持公开仓库；私有仓库需要相应 Enterprise 能力。**写 `environment: production` 并不建立人工批准门禁。** 本轮没有创建虚假的 Environment 审批，也没有为获取能力改变仓库可见性或购买套餐。[环境规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

因此工作流只产出下载候选。负责人确认具体 SHA、Review、CI、候选摘要、主机目标和维护窗口后，才可另外授权实际部署。管理员仍可修改仓库规则或工作流；工具不声称能防御有权控制仓库/宿主机的恶意管理员。

## OCI 与三个不同的摘要

四个 target 为 app/tools/proxy/operations。BuildKit 直接输出 OCI archive，不向镜像仓库推送；构建不会取得部署密码或签名密钥。构建只绑定依赖/base digest，仍可能受 apt 仓库变化影响，不能承诺相同源码每次构建的字节绝对相同。

`release.json` 记录源码、实时门禁证据、001–008 checksum、Schema/权限/秘密/内容/Compose 合同及每份归档的：

| 字段 | 含义 |
| --- | --- |
| `indexDigest` | OCI 顶层 descriptor digest；若没有附属 index，它与 manifestDigest 相同 |
| `manifestDigest` | linux/amd64 的实际镜像 manifest，绑定配置和各层 |
| `configDigest` | 镜像配置的摘要，不能冒充 manifest digest；containerd 的 Docker image ID 也可能指向 index |
| `archiveSha256` | 整个 tar 下载文件的 SHA-256，包含归档包装，不等于 OCI digest |

校验器不解压到文件系统；流式核对全部 blob、descriptor 大小、引用完整性、平台、非 root 用户和源码 label，拒绝损坏、缺层、路径穿越、重复路径和链接。未验证的下载不能直接 `docker load`。镜像层/配置检查不能证明“没有任何秘密”，真正的前提仍是白名单 Docker context 和无秘密构建流程。

候选保存为私有 Actions Artifact，保留 1 天，不上传数据库备份或媒体目录。摘要写入对应 run 的 Summary；从可信 run 取得 `release.json` 摘要，再执行：

```sh
node scripts/release/cli.mjs verify /private/download/mq-release EXPECTED_RELEASE_JSON_SHA256
```

不要把同一未知下载中附带的 checksum 当作信任来源；SHA-256 是完整性校验，不是签名。当前未实现独立签名/attestation 验证。四份归档存在共享层重复，运行前核对 Actions 存储配额和本地磁盘；本轮不提高付费额度。长久保留候选和异地签名策略须另行确认。

默认不使用私有 GHCR，服务器无需长期 PAT。受信运维电脑登录 GitHub 下载 artifact，核对后通过已批准的安全传输交付目标主机。不得把 GitHub token、Actions 下载授权头写入服务器 Compose。若将来改为 registry，另行评审短期只读 pull 凭据、包可见性和撤销，不直接落长期个人 PAT。

OCI 加载要求经验证的 Docker Engine containerd image store。工具不切换现有主机 storage driver；旧驱动会被拒绝。切换驱动可能暂时隐藏已有镜像/容器，必须另行安排。依据：[OCI 导出](https://docs.docker.com/build/exporters/oci-docker/)、[OCI image layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md)、[Docker containerd store](https://docs.docker.com/engine/storage/containerd/)。

## 默认计划、生产拒绝

`cli.mjs plan` 只读取候选和当前版本、目标 manifest、已验证备份 receipt，然后输出计划，不加载镜像、不运行 Compose、不访问远端主机。配置和 receipt 必须在 Git 之外并符合既有文件权限规则。

```sh
node scripts/release/cli.mjs plan \
  /private/candidate CANDIDATE_MANIFEST_SHA256 \
  /private/current CURRENT_MANIFEST_SHA256 \
  /srv/mq/config/deployment.json /srv/mq/backup-status/verified.json
# 增加最后一个参数 rollback，仅规划兼容的应用回退。
```

必须有本 deploymentId 的近期完整备份（≤26小时）；它不证明异地备份可恢复。更新/回退首版均要求 8 项迁移与 Schema、权限、秘密、内容和 Compose 合同完全相同；未来新增迁移必须另审升级及回退兼容性，不能在此绕过。

合成实验通过 `applySyntheticRelease({plan,confirmation,execute})` 执行固定步骤：关闭入口、停止 app、迁移/重新 provision、运行身份 audit、启动候选、健康检查、恢复入口。回退跳过 migration/provision。`execute` 由本地隔离 lab 映射到已有 Compose/database-cli，沿用不同角色与受限秘密挂载。计划只接受随机 staging 数据库及 `.localhost` HTTPS；生产 apply 明确拒绝。确认 deploymentId 只防错目标，不是授权凭据。

任何步骤失败均重新关闭入口并停止 app；只有确认成功才报告关闭，否则报告 `RELEASE_FAILED_CONTAINMENT_UNCONFIRMED`，需要操作者介入。不会悄悄重试写入、还原数据库或恢复旧秘密。回退是另一次显式动作，先检查当前数据库与旧镜像仍兼容，再按 digest 启动旧应用。平台故障不是可以自动回滚数据的理由。

## 将来真正部署时的顺序

1. 完成主机公钥/防火墙、域名、正式 HTTPS、最小权限、秘密托管、异地备份、安全 Review 和负责人部署授权，核对 linux/amd64 与 OCI 加载支持。
2. 在受控 staging 核验候选，用真实 main SHA/Review/CI/摘要记录验收；选择维护窗口、当前版本和回退候选。首次部署仍按 `PRODUCTION_FOUNDATION.md` 进行空库 bootstrap/migrate/provision/audit，不将本更新工具用于接管未知数据库。
3. 关闭入口/写进程，暂停身份并排空连接，完成成套加密备份和恢复可用性检查。备份失败停止更新。
4. 在 app 停止且数据库私网隔离状态下显式恢复迁移登录，分别用 migration/provision 所需身份执行既有 CLI；运行 runtime audit。不要把引导/迁移文件挂到 app。
5. 校验归档后加载镜像，核对实际 Docker descriptor digest；用精确 digest 配置候选，保持既有秘密和数据库/媒体持久卷。主机没有任何拉取凭据也能加载已验证 OCI archive。
6. 受控验证健康、HTTPS、公开图文/分享、登录、管理权限、点赞/留言和备份，不误开放生产开关；负责人确认后才开放入口。程序当前没有生产 apply，届时须单独授权、审查并演练具体主机执行路径。
7. 故障时入口保持关闭；兼容回退仅切镜像。数据库 down migration、reset、旧秘密恢复不属于回退。不可兼容时向前修复或经独立授权恢复到全新隔离目标，明确恢复会损失 snapshot 后的数据。

## 本轮证据与未验证部分

- `node --test tests/release.test.mjs`：Review/CI/祖先门禁、OCI 完整性、目标/备份限制、故障闭入口及回退不改数据库等定向检查。
- `node scripts/release/integration.mjs`：真实 BuildKit 导出约 1MiB 合成 Linux 镜像，完整校验后 Docker load，并按同一 digest 以 UID10001 执行。精确清理本次容器/builder/镜像，无全局 prune。
- 实际 GitHub 只读门禁对 main `c9ddbf988151ea4587533b52d8a38477595dfe80` 通过：PR #48 Review `49a3e65`，Quality run `42241561387`。这不等于当前 P4 提交已获审批。
- 完整应用/数据库/代理更新与故障回退证据由 P4 release lab 记录；最终以本 PR 最终 SHA 的 CI 为准，不把小镜像实验当作完整应用验收。
- 新 workflow 尚未进入默认分支，**未实际执行手动候选 workflow 或验证 Artifact 上传**；GitHub 要求 workflow_dispatch 文件先进入默认分支。合并后还需负责人授权一次真实手动运行，核对配额、构建、下载和 run 摘要。[手动工作流前提](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- 真实 VPS、真实域名、生产凭据、正式部署、独立产物签名和生产回退均未验证。不把合成环境通过称作上线完成。

2026-11-06 本地联合验收：`npm run check`、`test:release`，以及 `test:db`、`test:production:db`、`test:auth:limiter`、`test:auth:transactions`、`test:auth:logs`、`test:auth`、`test:admin`、`test:admin-drafts`、`test:admin-editor`、`test:admin-preview`、`test:public`、`test:likes`、`test:comments`、`test:media`、`test:media:upload`、`test:media:stories`、`test:publishing`、`test:media:lifecycle`、`test:production:rotation`、`test:auth:session-spike` 均退出0。

`test:production:operations` 与 `test:production:release` 均退出0，分别使用本地 Restic 和私网 HTTPS S3 模拟仓库。后者包含 PostgreSQL18完整迁移/身份核验、两个素材四个文件恢复、旧Session/签名失效、公开与私有图片GET/HEAD、DPR2桌面/手机实际图片解码、五类SCRAM与业务密钥轮换，以及故障镜像闭入口、按digest回退、断库503和恢复。最终一次本地备份/恢复/恢复到HTTPS耗时6.662/2.539/17.779秒，S3模式为9.419/3.838/18.511秒；不能据此承诺真实VPS或真实异地网络的RTO。

S3仅使用固定官方 Moto 5.2.5 镜像和临时 Caddy CA，无host端口；启用IAM模拟并实际拒绝错误access key/签名。它能验证Restic的真实S3读写、TLS、加密和恢复路径，不能证明未来云供应商IAM、配额或网络可用性。[Moto服务模式](https://docs.getmoto.org/en/latest/docs/server_mode.html)、[IAM模拟限制](https://docs.getmoto.org/en/latest/docs/iam.html)。保留策略只执行dry-run，未删除任何真实备份。

集成时修复了原始Compose的manifest挂载路径不一致，并对未覆盖的Compose配置增加断言；新演练初次因测试卷名称和Caddy测试配置而失败，修复后完整重跑。跨UID回执测试还发现测试容器的root专属/tmp阻止UID10001访问，现仅该无网络、无宿主挂载的测试使用1777/tmp，真实私密子目录仍700。原失败日志保留在本机临时证据目录，未上传含备份或秘密的测试目录。最终Linux CI以本PR最新提交的Actions链接为准。
