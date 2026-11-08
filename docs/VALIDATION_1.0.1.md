# 1.0.1 测试包验证报告

日期：2026-11-08。GitHub 发布已按用户要求暂停；本次提供测试包，等待用户确认后再继续上传或公开。

**真实 Windows + Prism 11.1.1 的两个故障场景：未实机验证。** 不把自动化、托管 CI 或接口请求当作实际整合包导入成功。

| 当前版本验证 | 结果 | 范围 |
| --- | --- | --- |
| Linux / Node.js 24.22.1 自动化 | 54/54 通过 | 含 498 ID、慢上游、失败批次、缺失 ID、截止时间、压缩、并发与取消 |
| 真实普通 API 回归 | 23/23 通过 | Minecraft/加载器元数据及 MCIM API；显式为 `--api-only` |
| ATM10 8.5 两阶段接口 + 10-ID 字段比对 | 3/3 通过 | `/v1/mods/files` 498 文件；`/v1/mods` 498 项目，字段比对一致 |
| LegacyFTB 原始端点及工具透传 | 两份 XML 均通过 | 可达上游代理路径均 200，XML 有效，工具透传后 SHA256 一致 |
| 严格 X.509 | 7/7 通过 | OpenSSL 严格链验证、错误主机/根证书拒绝、日期和密钥标识 |
| CLI 生命周期 | 通过 | 初始化、带空格路径、配置/撤销、服务、doctor；无系统信任库改动 |

修复逻辑、基线测量、缺失 ID 语义和配置事项见 [两项问题的完整报告](NETWORK_FIXES_1.0.1.md)。

## 大包接口实际结果

- `POST /v1/mods/files`：498 输入、498 返回，约 10.7 秒；保持一次文件查询。
- `POST /v1/mods`：498 输入、498 返回，无缺失，约 22.3 秒；10 批、最多 3 批并发。
- 上游项目数据压缩传输约 1.55 MB，解压约 8.21 MB；JSON UTF-8 转换/解析累计约 61.82 ms。
- 原始 identity 单请求在 25 秒观察预算内只收到约 0.62 MB，未收完 8.21 MB。gzip 单请求在同样观察窗口也未完成；分批与有限并发后的请求已完整返回。
- 任何必要批次失败时不会提前发成功响应；默认整体预算 45 秒，超过预算明确返回 504。

## 环境限制与剩余人工验证

完整文件下载回归的一次尝试受到本环境对 `mediafilez.forgecdn.net` 的网络策略限制，未能完成。没有绕过该限制或改写 MCIM 要求保留的域名；之后的 23 项 API 检查显式跳过了 7 项文件/资源下载检查，不把它们计为通过。

本次没有在真实 Windows + Prism 中重新导入 ATM10、下载全部模组或进入游戏；也没有在用户机器上确认 LegacyFTB 的具体网络拦截原因。用户仍需检查实际可用的上游 HTTP 代理，验证升级后的 Prism 行为及根证书交互确认。

此前 1.0.0 的官方 Prism Linux GUI、原始解析器、文件哈希和三平台 CI 结果保留在 [历史报告](VALIDATION_1.0.0.md)。那些历史结果不代表 1.0.1 的两个场景已经实机修复。当前 1.0.1 尚未上传到 GitHub 或运行新的托管 CI。

## 打包检查

发布构建脚本会排除本地 CA、私钥、缓存和配置备份。ZIP 另从新目录解压，核对 CRC、完整文件清单、Node 官方哈希，并再次运行全部离线测试和 CLI 生命周期；具体结果见 `test-results/package-check-1.0.1.json`。

## 原始记录与复现

- `test-results/unit.tap`：54 项自动化。
- `test-results/live-report.json`：23 项 API 回归及 7 项明确跳过的检查。
- `test-results/bulk-upstream-benchmark.json`：受控基线测量。
- `test-results/bulk-live-report.json`：1.0.1 真实 498-ID 查询。
- `test-results/legacy-ftb-origin-report.json`、`legacy-ftb-bridge-report.json`：两条连接路径的 XML 检查。
- `test-results/certificate-report.json`、`regression-network-limit.json`：证书与环境限制。

```sh
npm test
node scripts/bulk-live-test.mjs
node scripts/live-test.mjs --api-only
node scripts/certificate-check.mjs
node scripts/smoke-test.mjs
```

联网功能检查会访问公共镜像，请合理使用，不要反复并发运行。
