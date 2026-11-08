# v1.0.2 Windows 发布验证

**用户已在 Windows 环境实测确认 1.0.2 可正常使用。正式支持与发布平台为 Windows x64。** 维护环境没有远程访问用户机器；用户实机反馈、Windows 托管检查和历史故障诊断分别记录。

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| Windows 用户实机 | 已确认正常使用 | 用户明确反馈本版本在 Windows 可用 |
| Windows x64 / Node.js 24.22.2 CI | 68 通过、2 跳过、0 失败 | 共 70 项；两个历史 POSIX 专用检查跳过 |
| Windows CLI 生命周期 | 通过 | PowerShell 进程检测；临时目录中的接入、元数据修复、撤销和服务启动 |
| 生产程序与用户确认包对比 | 一致 | `src`、`data`、CLI、配置、版本和操作脚本逐文件核对 |
| 正式 ZIP | 解压与文件清单检查 | 安全路径、CRC、每个文件 SHA256 和官方 Windows Node.js 运行时哈希 |

[Windows CI 原始运行](https://github.com/sem0418/PrismMirrorBridge/actions/runs/42470784807)；机器可读摘要见 `test-results/github-ci-release-1.0.2.json`。无人值守 CI 明确跳过需要桌面确认的 Windows CA 对话框；用户实机反馈保留独立来源标记。

## 本次修复

修正“省略 sha256 就能清除已有期望值”的错误假设。Prism 11.1.1 合并无哈希条目时会保留已有哈希；替换磁盘索引不能重置运行中对象的校验状态。

- 接入、修复和撤销均检查 Prism 是否退出；检查失败时停止，不杀死进程。自定义改名版本仍需用户自行完全退出。
- 整个 `meta` 目录移动到同级备份，保留旧索引、旧组件和失败临时文件；实例、账号、模组、资源保留。
- 迁移步骤先记录再执行，支持进程中断续办；目录冲突时拒绝覆盖。没有对断电后的文件系统持久性作保证。
- `05-repair-metadata.cmd` 用于旧版接入状态修复，不重复操作证书信任；全新接入运行 `01-setup.cmd` 已包含元数据隔离。
- 转换响应字节、TLS 和游戏/模组文件哈希校验保持原样。转换索引仍使用 Prism 原生可选元数据哈希语义，本次未实现转换元数据的完整哈希链。

升级和完全重装步骤见 README。具体哈希来源、用户提供证据的边界和修复对照见 [NeoForge 报告](docs/NEOFORGE_CHECKSUM_DIAGNOSIS.md)。

## 发布检查

发布整理只修改文档、CI 支持范围及匿名诊断时间戳，不改变用户确认的生产程序。原测试包及正式包分别有记录；正式包结果见 `test-results/package-check-release-1.0.2.json`，[发布记录](docs/PUBLICATION_1.0.2.md)说明对应源码和 CI 范围。

开发回归命令：

```sh
npm test
node scripts/smoke-test.mjs
```

Windows 桌面可自行选择交互式 `node scripts/smoke-test.mjs --windows-trust`，其中临时信任会在结束时移除。普通测试和 CI 不改变系统信任库。

## 历史诊断资料

历史维护环境中曾完成 70 项离线检查、11 项原始 Prism 校验逻辑最小诊断、官方 Prism 11.1.1 Linux 可执行文件受控组件对照，以及真实 BMCL 的 NeoForge 21.1.265 转换。受控对照仅提供目标 NeoForge 组件，对非目标 Minecraft 索引明确返回 404，因此不等同于完整整合包导入。这些记录用于故障研究，不构成其他平台支持承诺。

NeoForge 真实转换仍为 36042 字节，SHA-256 为 `b7542fda4c29695219c27cac053947ea85a691044d0fb17690889540e7dd3ce1`。相关记录保留在 `test-results/neoforge-live-1.0.2.json`、`official-prism-checksum-1.0.2.json` 和 `prism-hash-state-1.0.2.json`。

1.0.1 的 498-ID 查询、23 项 API 回归、LegacyFTB 两份 XML 及当时证书检查见 [历史报告](docs/VALIDATION_1.0.1.md)。本轮不重复全部联网回归。

LegacyFTB 仍依赖可达网络或上游 HTTP 代理；Modrinth 文件可能被 MCIM 重定向回官方 CDN，GET 元数据压缩尚未在此版本扩展。此前完整文件回归受到维护环境对 `mediafilez.forgecdn.net` 的网络策略限制，相关检查没有计为通过。
