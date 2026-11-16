# Restic 构建与安全验证

P5-05C 使用 **MQ patched rebuild**：Restic 0.19.1 的官方签名源码、官方 Go 1.27.3 编译器，以及固定的依赖补丁。它不是 Restic 官方发行二进制。Restic 的 `.go` 源码和仓库格式未修改。

## 选择与供应链

2026-11-09 核查的[最新官方发行版](https://github.com/restic/restic/releases/tag/v0.19.1)仍是 0.19.1；[上游问题 #22132](https://github.com/restic/restic/issues/22132)记录该发行包所用 Go 1.26.4 未拒绝被破坏的 emSign 中间证书。MQ 的 OSS 备份实际使用 TLS，不能仅靠加密备份内容规避这个认证问题。[GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809)的修复编译器为 Go 1.26.10 / 1.27.3。

- `ops/restic-source-provenance.json` 记录源码、签名、签名者指纹、编译器镜像 digest 和补丁摘要。
- 实际 GPG 验证签名者为 `CF8F18F2844575973F79D4E191A6868BD3F7A907`，与[官方安装说明](https://restic.readthedocs.io/en/stable/020_installation.html)一致。GPG 显示本地信任库未设置该身份信任；不能将此警告改写为签名无效或完整供应链保证。
- Dockerfile 用 `ADD --checksum` 固定官方源码和仅作互读测试的旧官方二进制；校验源码原始及补丁后的 `go.mod` / `go.sum`；执行 `go mod verify` 后断网构建。`GOTOOLCHAIN=local` 禁止隐式下载另一个编译器。
- 构建采用上游 `go run build.go`，保留默认 build tags。operations 最终镜像只复制新 Restic 和来源/构建清单，不包含 Go 编译器、源代码或旧二进制。builder 的 `patch` 来自签名验证的 Alpine 软件源；应用补丁后的完整锁文件仍须匹配固定摘要。
- 软件升级继续重新构建镜像；MQ 备份命令白名单不允许 `self-update`、任意参数、关闭 TLS 校验或执行真实保留删除。

依赖改动只修复实际 HTTP/2 与压缩路径及最小版本选择所要求的闭包：

| 模块 | 原版本 → 新版本 | 原因 |
| --- | --- | --- |
| `golang.org/x/net` | 0.55.0 → 0.62.0 | `internal/backend/http_transport.go` 直接调用 `http2.ConfigureTransports`，包括 S3 transport |
| `github.com/klauspost/compress` | 1.18.6 → 1.20.2 | 仓库读写使用 zstd；消除已知 FSE/huff0 和 S2 缺陷 |
| `golang.org/x/crypto` | 0.52.0 → 0.58.0 | x/net 0.62.0 的 go.mod 要求 |
| `golang.org/x/sys` | 0.45.0 → 0.49.0 | x/net / x/crypto 要求 |
| `golang.org/x/term` | 0.43.0 → 0.47.0 | x/net / x/crypto 要求 |
| `golang.org/x/text` | 0.37.0 → 0.43.0 | x/net / x/crypto 要求 |
| `golang.org/x/sync` | 0.20.0 → 0.24.0 | x/text 0.43.0 要求 |

补丁同时把模块最低 Go 版本调整为依赖所需的 1.26.0，移除旧的 1.25.10 toolchain 提示；实际编译器仍严格为 1.27.3。没有更新无关的 gRPC、OpenTelemetry 或云后端链。

## 可重复验收

`docker build --target operations .` 会运行 `restic-build` 的以下断网测试，失败会阻止 operations 产物生成，无额外 CI 跳过开关：

1. `verify-distrust.go` 对公开的已失陷中间证书建立显式 trust anchor，固定验证时间；新版 x509 必须仍拒绝其 SPKI。证书 fixture 不是秘密，也不包含私钥。
2. `roundtrip.sh` 在容器内新目录执行仓库 v2 初始化、合成数据备份、快照列举、完整读取校验、精确快照恢复及逐字节比较；错误仓库密码必须失败，原仓库随后仍可校验。
3. `cross-version.sh` 验证旧官方 0.19.1 写入 → MQ 完整校验/恢复；MQ 新备份 → 旧官方完整校验/恢复。仓库配置始终为 v2 且前后相同。

另在本地执行了固定 Go 1.26.4 官方镜像的负控：同一证书被接受，程序按设计退出 1。Go 1.27.3 退出 0。该测试覆盖 x509 撤信任行为，不是假造 TLS 服务器或关闭证书检查。

第二个独立、断网、冷 Go 构建缓存的构建与第一次逐字节相同：

```text
restic 0.19.1 compiled with go1.27.3 on linux/amd64
SHA-256: 8aa101f82b96d48a9719ac44ceb83f3cac89e92070494adda2dcbda3488f9f7d
```

这是 Restic ELF 二进制摘要，不是 operations 镜像 digest。最终镜像扫描与正式候选仍须另行绑定源码 SHA 和镜像摘要。

## 扫描结果与剩余边界

2026-11-09 使用 `govulncheck v1.9.0 -mode=binary`；数据库时间为 `2026-11-05T23:49:57Z`。最终补丁二进制的文本扫描退出 **3**：6 项 symbol-level 漏洞、3 个模块，另有 1 项 module-only 漏洞。JSON 输出模式退出 0 是该输出模式的行为，**不表示扫描通过**。GO-2026-6809 及旧 x/net、compress、x/text 的命中已消失。

| 保留项 | 版本 / 上游修复信息 | MQ 路径与限制 |
| --- | --- | --- |
| GO-2026-5932 | x/crypto 0.58.0；数据库给出 0.58.1 的移除提交 | `internal/selfupdate/verify.go` 使用废弃 OpenPGP。MQ 不调用自更新；二进制默认功能仍存在，没有宣称库问题已修复 |
| GO-2026-6061 / GHSA-hrxh-6v49-42gf | grpc 1.81.1 → 1.82.1 | gRPC transport / xDS RBAC；MQ 只允许 local/S3 备份，不启动 gRPC server |
| GO-2026-6348 / CVE-2026-84304 | grpc 1.81.1 → 1.83.1 | HTTP/2 DATA 分片内存耗尽；包含客户端路径，不能泛称为仅服务端问题 |
| GO-2026-6441 / CVE-2026-84303 | grpc 1.81.1 → 1.83.1 | xDS RBAC header matching；MQ 不配置 xDS |
| GO-2026-6443 / CVE-2026-84445 | grpc 1.81.1 → 1.82.2 | server authority/header panic；MQ 不提供 gRPC 入口 |
| GO-2026-5158 / CVE-2026-41178 | otel 1.43.0 → 1.44.0 | baggage header 长度限制；MQ local/S3 路径不接受远程 baggage header，不导入进程的 OTEL 环境变量 |
| GO-2026-6505 / CVE-2026-81870 | otel 1.43.0 → 1.45.0 | module-only 配置日志泄露；保留原始命中，不等同于已确认被调用 |

`build.go` 默认包含 `disable_grpc_modules`；Google Storage 后端源码选择 HTTP transport。二进制扫描只能证明符号或模块存在，不能证明从 MQ 参数入口可到达全部相关调用，也不能代替完整形式化不可达证明。MQ 包装器只接受固定 local/S3 操作，子进程环境只继承受限变量，没有自更新或任意后端输入。这些是风险收敛条件，不是“整个镜像无漏洞”结论。任何新增后端或任意 Restic 命令入口需重新审查。

## 证据与范围

本地证据：项目外受限证据集 `p505c-restic-20261109`（不随仓库分发，不是构建依赖）。其中保留源码签名记录、原/补丁锁文件、构建日志、新旧互读、冷缓存可复现性、旧/新 govulncheck JSON 和文本及真实退出码。早期缺少 builder `patch`、临时文件系统 noexec 等失败也保留，未当作有效安全测试。

这些测试仅使用本地合成仓库，没有连接 OSS 或 VPS，没有改动生产秘密与既有备份。完整 S3/数据库恢复回归和五类最终镜像扫描在本阶段集成验收中执行；不得以本页单个二进制测试替代它们，也不得自动推导公网开放授权。
