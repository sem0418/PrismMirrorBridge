# Prism Mirror Bridge

独立运行的 Prism Launcher 镜像转换工具。它在本机提供 Prism 所需的组件元数据，并把指定下载请求转交 BMCLAPI / MCIM。无需重新编译 Prism。

**[下载 Windows x64 便携包](https://github.com/sem0418/PrismMirrorBridge/releases/latest)** · [更新记录](CHANGELOG.md) · [测试报告](TEST_REPORT.md) · [参与开发](CONTRIBUTING.md)

请在 Release 中下载 `PrismMirrorBridge-1.0.0-Windows-x64.zip`。GitHub 的 **Code → Download ZIP** 和自动生成的 **Source code** 只包含源码，需要自行安装 Node.js 24.5+；便携运行时放在 Release 附件中。

## Windows 使用

1. 把整个目录解压到可写位置。便携包已附带 **Node.js 24.22.2 Windows x64**，不需要安装 npm 依赖。
2. 关闭 Prism，运行 `01-setup.cmd`，选择 **Prism 数据目录里的 `prismlauncher.cfg`**。普通安装通常在 `%APPDATA%\PrismLauncher`；便携版请用 Prism 菜单里的“启动器根目录”定位。
3. 接入脚本会保存原有网络设置，并将本次安装生成的本地 CA 加入**当前 Windows 用户**的信任库。这是兼容 Prism 固定 HTTPS 模组地址所需的步骤。
   Windows 可能显示证书安全确认窗口；请核对证书属于本次安装生成的 `Prism Mirror Bridge` CA 后再确认。无人值守 CI 无法代替这一步交互验收。
4. 运行 `02-start.cmd`，保持窗口打开，然后启动 Prism。
5. 浏览器打开 <http://127.0.0.1:17643/> 可查看配置地址，<http://127.0.0.1:17643/health> 可查看请求计数。

建议先新建一个 1.20.1 + Fabric 实例，搜索并下载一个模组，确认本机接入正常后再使用其他实例。现有实例、账号和游戏文件不会被接入脚本删除。

默认严格使用 BMCL 游戏元数据，请在 Prism 中选择已有的适用 Java。若需要 Prism 的 Java 自动下载或额外老组件配方，可按下文显式启用兼容模式。

**撤销：**关闭 Prism，运行 `03-undo.cmd`，选择同一个配置文件。它恢复接入前的网络字段、保留之后修改的其他设置，并移除本次安装的 CA 信任。如果同一工具接入了多个 Prism 数据目录，先分别恢复所有目录，再移除 CA 信任。

工具关闭而代理设置仍保留时，Prism 的网络请求会失败；先重新启动工具，或撤销接入。

## 转换了什么

| 请求/数据 | 实际处理 |
| --- | --- |
| Minecraft 版本列表 | BMCL Mojang manifest → Prism `uid / versions / version / requires` 格式 |
| Minecraft 版本文件 | BMCL Mojang JSON → Prism Minecraft、LWJGL 两个组件；转换 `mainJar`、Java 要求、启动参数和 traits |
| 原生库 | 保留操作系统规则；应用 Prism 兼容补丁；分开保存 split-native 工件，避免被合并覆盖 |
| Fabric、Quilt | 从 BMCL loader 信息或 loader JAR 内的安装描述转换为 Prism patch；映射独立的 intermediary 依赖 |
| Forge、NeoForge | 从 BMCL Maven 列表和 installer JAR 读取版本、依赖与处理器信息，生成 `libraries / mavenFiles / +tweakers` 等 Prism 数据 |
| CurseForge 批量查询 | Prism 发来的字符串 ID 数组 → MCIM 要求的整数数组 |
| CurseForge 项目介绍 | MCIM 不提供完整介绍时，使用其真实项目摘要，转义 HTML 并明确标注内容范围 |
| Modrinth / CurseForge API | 通过 Prism 的 HTTP 代理转交 MCIM，保持原平台响应结构，移除 MCIM 的 `sync_at` 扩展字段 |
| 模组文件与 CurseForge 图标 | 保留 Prism 需要校验的原始外部地址；在传输层切换到 MCIM，兼容 `.mrpack` 的下载域名检查 |
| 游戏客户端、资源索引、assets、常规 Maven 库 | 改写到 BMCL；文件内容和上游提供的 SHA1/SHA512/size 保持不变 |

不会修改 Prism 可执行文件，也不需要写 hosts 或设置系统全局代理。只监听 `127.0.0.1`。

## 需要准确区分的边界

- **默认不会把失败的游戏元数据请求悄悄转回 Prism 官方源。**`compatibilityRecipes` 默认为 `false`。若显式启用 `true`，Java 运行时元数据、非标准手动 LWJGL 版本，以及无法转换的老组件可按需读取 Prism 官方兼容描述。主要转换链路的联网测试关闭了兼容配方，验证没有访问 Prism 元数据源。
- BMCL 的版本接口遇到部分 404/5xx 时，可尝试同一个 BMCL 根地址下的 manifest 对应文件路径；不会因此改用 Mojang 或 Prism 官方地址，也不会绕过 429 限流。
- 保持 `compatibilityRecipes: false` 时，无法处理的组件会明确报错。新实例使用 `bridge-<Minecraft版本>` 的 LWJGL 组件。已解析游戏版本对应的普通 LWJGL 版本可自动复用 BMCL 数据；其他手动替换版本仍可能需要兼容配方。ForgeWrapper、某些平台补丁等 Prism 支持文件可能保留其原下载源，所以这并不表示每个网络文件都只来自 BMCL/MCIM。
- MCIM 当前文档明确要求 **不要替换 `mediafilez.forgecdn.net`**。该域名保留原始 HTTPS 连接；`edge.forgecdn.net`、`media.forgecdn.net` 则走 MCIM。
- CurseForge 完整介绍接口返回 404 时，转换器使用 MCIM 的项目摘要并在正文标明“仅为摘要”。没有摘要、未缓存内容、更新日志及其他不支持的接口仍明确返回错误；不会伪造完整内容或空成功结果。
- 模组文件默认 `fileFallback: false`：镜像失败会报错；改为 `true` 后才允许在 MCIM 文件失败时尝试原地址，`/health` 会显示回退次数。MCIM 本身也可能返回到其他 CDN 的重定向。
- Microsoft 登录、Xbox、Minecraft 账号服务等不在解密名单内，代理只转发加密连接。这里验证了透传机制，没有使用真实账号执行登录。
- 已在隔离 Linux 桌面中运行**官方 Prism 11.1.1**，验证组件解析、Fabric 安装选项和界面内模组下载。另用未修改的 Prism 原始解析代码验证 25 份组件数据。**Windows 信任脚本、真实账号登录及进入游戏仍未实机验收**。详细范围和原始记录见 [TEST_REPORT.md](TEST_REPORT.md)。

## 配置

`config.json` 中常用选项：

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `port` | `17643` | 本地服务及 HTTP 代理端口；改端口后需要重新执行接入脚本 |
| `bmcl` | `https://bmclapi2.bangbang93.com` | BMCL 根地址 |
| `mcim` | `https://mod.mcimirror.top` | MCIM API/文件根地址 |
| `compatibilityRecipes` | `false` | 显式开启后才允许按需获取 Prism 官方兼容描述 |
| `fileFallback` | `false` | MCIM 模组文件失败时是否允许尝试原源 |
| `upstreamProxy` | `"environment"` | 使用 HTTP(S)_PROXY 环境变量；`""` 表示直连；也可以填 `http://127.0.0.1:7890` 等 HTTP 代理 |
| `concurrency` | `4` | 上游并发上限，最多可设为 8 |
| `timeoutMs` | `30000` | 建连/响应头及传输无进展超时；有持续流量的大文件允许超过此总时长 |
| `retries` | `2` | GET/HEAD 遇到临时失败时的额外重试次数；尊重短期 Retry-After，长等待则直接报告错误 |
| `cacheSeconds` | `300` | 成功元数据的缓存有效期 |

如果原 Prism 使用了单独的代理，请把它的 HTTP 代理地址填到 `upstreamProxy`；不要填本工具自己的端口。不支持将 SOCKS5 地址直接作为上游代理。环境变量中的代理地址也不能指回本工具。

运行状态、缓存与本地证书保存在 `.bridge`。CA 私钥每次安装独立生成，不包含在分发包中。不要把自己的 `.bridge` 或配置备份复制给其他人。清缓存时先停止服务，只清 `.bridge/cache`，不要删除仍被信任的证书。

## 手动接入和开发

需要 Node.js **24.5 或更新版本**。Windows 可用 `runtime\node.exe` 代替以下命令里的 `node`。

```sh
node cli.mjs init
node cli.mjs configure --prism-config "你的数据目录/prismlauncher.cfg"
node cli.mjs trust-ca   # 仅 Windows：信任当前安装的 CA
node cli.mjs serve
```

Prism 对应的设置如下：

```ini
[General]
MetaURLOverride=http://127.0.0.1:17643/meta/v1/
ResourceURLOverride=http://127.0.0.1:17643/assets/
ProxyType=HTTP
ProxyAddr=127.0.0.1
ProxyPort=17643
ProxyUser=
ProxyPass=
```

只改元数据地址不足以接入模组 API；还需要代理设置和证书信任。Linux/macOS 可运行 Node 源码，但证书要导入 Prism 所用 Qt 的信任库。Linux 的隔离测试通过 Qt 公共接口仅添加测试 CA，保留正常 TLS 校验；这不代表已提供 Linux/macOS 自动安装脚本，且仅设置 `SSL_CERT_FILE` 不保证所有 Prism 构建可用。

```sh
node cli.mjs doctor
npm test
node scripts/live-test.mjs          # 会下载约几十 MB 的真实文件
node scripts/live-test.mjs --quick  # 跳过较大的 Minecraft 客户端 JAR
node cli.mjs restore --prism-config "你的数据目录/prismlauncher.cfg"
node cli.mjs untrust-ca             # 仅 Windows
```

可选深入验证需要 GCC 14+、Qt 6 开发文件及对应 Prism 源码；日常运行无需这些依赖：

```sh
node scripts/certificate-check.mjs # 需要 OpenSSL，严格校验证书
node scripts/build-native-probe.mjs --prism-source /path/to/PrismLauncher --qt-include /path/to/qt6 --out /tmp/prism-probe
node scripts/native-validation.mjs --probe /tmp/prism-probe
/tmp/prism-probe test-results/native-cases # 对交付的样本再次离线解析
```

测试结果写入 `test-results`。源码结构和接口研究见 [docs/DESIGN.md](docs/DESIGN.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建发布包

需要 Python 3。以下命令从 Node.js 官网下载固定版本 Windows 运行时，核对已固定的分发包和可执行文件 SHA256，再生成 ZIP 及 `SHA256SUMS.txt`；不会打包本地证书或配置备份。

```sh
python scripts/build-release.py
python scripts/check-release.py dist/PrismMirrorBridge-1.0.0-Windows-x64.zip
```

可通过 `--node-exe /path/to/official/node.exe` 复用同一版本的官方文件，仍会校验 SHA256。`SOURCE_DATE_EPOCH` 可固定 ZIP 时间戳。源码不提交运行时二进制；发布包内包含对应第三方许可和完整工具源码。

## MCIM 接入规则

本工具统一使用 `PrismMirrorBridge/1.0.0`，限制并发并缓存元数据。MCIM 文档要求接入前登记名称和 User-Agent，并禁止对其端点进行服务套壳。此项目仅作为本机 Prism 转接客户端交付；维护者在正式长期接入、公开分发或部署前，应向 MCIM 确认这种接入方式并完成登记。本次没有提交外部登记评论。

- [MCIM 当前接入指南](https://www.mcimirror.top/guide/start/getting-started)
- [MCIM 登记要求](https://www.mcimirror.top/guide/rules/register)
- [登记入口](https://github.com/mcmod-info-mirror/mcim-rust-api/issues/12)
- [MCIM 使用规则](https://www.mcimirror.top/guide/rules/policy)

许可证：GPL-3.0-only；随附 Node.js 按其自己的许可证分发。
