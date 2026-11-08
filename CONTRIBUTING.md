# 参与开发

需要 Node.js 24.5+。运行时没有 npm 第三方依赖，不需要执行 `npm install`。

```sh
npm test
node scripts/smoke-test.mjs
node scripts/certificate-check.mjs
```

`smoke-test.mjs` 使用独立临时目录；在 Windows 上会临时信任测试 CA、执行接入/撤销脚本并移除测试信任。证书严格检查还需要 OpenSSL。

接口样本位于 `tests/fixtures`，转换逻辑位于 `src/converters.mjs`。修复协议差异时请提供最小回归样本，保留上游内容哈希，并说明行为如何符合 Prism 的解析逻辑。可选的原始解析器和真实镜像检查见 README。

不要提交 `.bridge`、配置备份、账号目录、私钥或本地代理凭据。测试失败报告请保留状态码和组件版本，移除令牌、Cookie、用户名及个人路径。不要用压力测试验证公共镜像。

拉取请求请描述触发条件、最终行为及验证结果。贡献按本仓库 GPL-3.0-only 许可证提供。
