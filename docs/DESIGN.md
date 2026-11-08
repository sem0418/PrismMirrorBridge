# 接口研究与实现说明

研究和接口验证日期：2026-11-08。

## 为什么需要独立转换层

Prism 的元数据协议不是 Mojang 协议。它先取根 `index.json` 的 `packages`，再取 `<uid>/index.json` 的 `versions`，最后取 `<uid>/<version>.json`。版本文件由 `OneSixVersionFormat` 解析；组件关系通过 `requires`、`conflicts` 和排序字段描述。直接把 BMCL 的 `version_manifest_v2.json` 当作 Prism 元数据根地址，字段就不匹配。

MCIM 当前指南则明确说明：Modrinth 和 CurseForge 的主要 API 路径、参数、响应形状保持兼容。因此不应把所有 MCIM 数据当成另一种全新格式；实际需要修正的是 Prism 与 MCIM 的具体边界，包括 CurseForge 批量请求中字符串/整数 ID 的差异、MCIM 扩展字段，以及 Prism 对模组文件地址的校验。

本工具以本地客户端方式接入：

| Prism 请求 | 转接过程 | 上游 |
| --- | --- | --- |
| 元数据服务器 | `MetaURLOverride` → 本机组件转换器 | BMCL manifest、loader meta、Maven XML、installer JAR |
| 游戏资源 | 显式地址重写、ResourceURLOverride 或指定域名代理 | BMCL 客户端、assets、Maven 文件 |
| 模组 HTTPS | Prism HTTP CONNECT → 指定域名 TLS → API 适配/文件转发 | MCIM |
| 账号及其他 HTTPS | CONNECT 字节透传 | 原服务，或用户指定的上游 HTTP 代理 |

使用本工具无需重编译或替换 Prism 的程序文件。交付物是独立 Node 服务。

## Prism 端读取结论

研究的源码提交：`899d2f3957215a09fe398a8a8cbb8a8a9c619968`。另运行官方 Linux Prism 11.1.1 验证真实 UI，并编译未修改的上游解析源文件检查 25 份转换结果。Linux 测试使用仅添加本次 CA 的 Qt 启动测试辅助库；未关闭证书校验，也未修改启动器二进制。它是诊断设施，不随日常运行加载。

| 源码位置 | 对实现的影响 |
| --- | --- |
| `launcher/Application.cpp` | 存在 `MetaURLOverride`、`ResourceURLOverride` 和 HTTP 代理设置；无需修改启动器代码 |
| `launcher/meta/JsonFormat.cpp` | 根组件、版本索引、版本 patch 的字段和格式版本要求 |
| `launcher/meta/BaseEntity.cpp` | 父级 `sha256` 会校验子元数据文件；改写 JSON 后不能保留旧文件的 SHA256 |
| `launcher/minecraft/OneSixVersionFormat.cpp` | 解析 `mainJar`、`libraries`、`mavenFiles`、`+traits`、`+tweakers`、`+jvmArgs` 等 |
| `launcher/minecraft/Library.cpp` | 普通库、native classifier、Maven 存储路径和校验机制 |
| `launcher/modplatform/flame/FlameAPI.cpp` | 部分批量 ID 由 QStringList 写入 JSON，产生字符串元素 |
| `launcher/modplatform/modrinth/ModrinthInstanceCreationTask.cpp` | 部分下载只接受 HTTPS 且要求外部域名为 `cdn.modrinth.com` |
| `launcher/net/ApiHeaderProxy.h` | 原 API 请求可能附带用户令牌或 CurseForge Key；转往公共镜像时不应转交这些凭据 |

本地 HTTP 请求还可能经过 Prism 自己配置的代理，所以服务器也能处理绝对形式的 `http://127.0.0.1:<port>/meta/v1/...`，避免误拒绝或递归转发。

## BMCL 转换

| BMCL 输入 | Prism 输出 |
| --- | --- |
| `/mc/game/version_manifest_v2.json` 中 `id/type/releaseTime` | `net.minecraft/index.json` 中 `version/type/releaseTime` |
| `/version/<id>/json` 的 `downloads.client` | `mainJar.downloads.artifact` 和 Maven 形式的主 JAR 名称 |
| Mojang `arguments.game` | 可直接支持的字符串参数；有条件的 quick-play 参数变为 Prism traits |
| `javaVersion` | `compatibleJavaMajors / compatibleJavaName` |
| 游戏 JSON 中的 LWJGL 库 | `org.lwjgl` 或 `org.lwjgl3` 独立组件，默认版本号 `bridge-<Minecraft版本>` |
| Fabric Meta 的 loader 描述 | loader 主类、库列表，以及独立 intermediary 组件依赖 |
| Quilt loader JAR 内 `quilt_installer.json` | Quilt patch；按当前 Prism 实现使用 Fabric intermediary |
| Forge Maven 版本及 installer 的安装描述 | Forge patch；旧版通过 tweaker，新版通过 ForgeWrapper 和 `mavenFiles` |
| NeoForge Maven 版本及 installer | NeoForge patch；保留处理器库和 installer 本身 |

Forge 老版本 Maven 坐标的 branch 后缀属于下载坐标，不属于 Prism 的组件版本号。例如 `1.7.10-10.13.4.1614-1.7.10` 对应 Prism 版本 `10.13.4.1614`。NeoForge 26.x 的版本号也需要额外解析 Minecraft 发行版、snapshot 和 prerelease 名称。

原生库、旧游戏版本和 Log4j 的兼容处理参考 Prism 官方元数据生成器。项目附带静态规则，来自提交 `9cac2ca1cf410146d3a04fbd33752820fefdd70e`；无需运行 Python 生成器。

split-native 的 artifact 重命名必须先于兼容补丁匹配。实际检查发现颠倒顺序会遗漏 Linux GLFW 3.3.1 的栈保护兼容修正；现已修复并下载替换 JAR 核对 SHA1。版本路由对包含空格的 Mojang ID 解码一次，接受 `3D Shareware v1.34`，仍拒绝路径分隔符、控制字符和嵌套编码。

BMCL `/version/<id>/json` 遇到指定的临时状态或 404 时，可使用 manifest 中对应文件的镜像路径。候选路径必须属于配置的同一 BMCL origin；不在 429 时回退，不访问 manifest 的原始官方地址。

元数据修改后，去掉指向已修改 JSON 的旧 SHA256。JAR、资源文件、安装器及库的真实内容哈希保留。资产索引作为原始字节转发，不重新序列化，避免其 SHA1 改变。

## MCIM 转接

研究的 MCIM Rust API 提交：`db477f78e1317e2a90a6b72a34a50d7ac5509792`，同时核查了当前官网指南和在线 OpenAPI。

- `api.modrinth.com/v2/...` → `mod.mcimirror.top/modrinth/v2/...`
- `api.curseforge.com/v1/...` → `mod.mcimirror.top/curseforge/v1/...`
- `cdn.modrinth.com/...`、`edge.forgecdn.net/...`、`media.forgecdn.net/...` → `mod.mcimirror.top/...`
- 按当前指南保留 `mediafilez.forgecdn.net`。
- CurseForge `modIds / fileIds` 中的数字字符串转换为整数，拒绝无效值、溢出和过大的列表。
- 响应保留平台原有结构，去掉 `sync_at` 扩展；若 MCIM 把 Modrinth 文件 URL 写为镜像地址，则恢复其 `cdn.modrinth.com` 外部身份，实际传输仍经 MCIM。
- CurseForge `/mods/<id>/description` 若在 MCIM 返回 404，读取其项目 `summary` 转换成 `{data: HTML}`，转义内容、标注仅为摘要，并返回 `x-prism-bridge-source: mcim-project-summary`。不存在的项目、空摘要、其他状态及 changelog 不会被此规则吞掉。
- Range、Content-Range、206、HEAD 及 Content-Length 在文件链路上保留；不修改文件字节。

## 实现与运行约束

| 模块 | 作用 |
| --- | --- |
| `src/converters.mjs` | Mojang、Fabric、Quilt、Forge、NeoForge 数据转换和静态兼容规则 |
| `src/metadata.mjs` | Prism 元数据路由、组件索引、installer 读取与可选兼容配方 |
| `src/routing.mjs` | 完整主机名映射、响应规范化和 HTTP 头过滤 |
| `src/mod-adapter.mjs` | CurseForge 批量 ID 及摘要介绍的格式转换 |
| `src/transport.mjs` | 上游代理、有限重试、并发限制、JSON 缓存、重定向和文件传输 |
| `src/certificates.mjs` | 用 Node crypto 生成安装独立的 CA 和指定域名证书 |
| `src/server.mjs` | 本地 HTTP 端点、选择性 HTTPS 转接和其他 CONNECT 流量透传 |
| `src/prism-config.mjs` | 保存原网络字段、原子写入配置、按字段恢复 |
| `tests/` | 真实响应样本的转换测试、本地伪上游集成测试 |
| `scripts/live-test.mjs` | 对真实镜像进行小规模功能下载和哈希验证 |
| `scripts/native-validation.mjs`、`tests/native/` | 上游原始解析器和 Qt 网络诊断；无需用于日常运行 |

所有运行库均为 Node 内置模块，不需要 npm install。上游建连、响应头和传输无进展默认 30 秒超时；持续下载可超过这一总时长。GET/HEAD 默认最多额外重试两次；长 Retry-After 不立即重试。跨域重定向不携带 Authorization、Cookie 或 API Key。日志不打印请求 URL、查询令牌或代理凭据。

CA 私钥只在使用者本机生成。证书签发函数只允许指定的镜像域名。Microsoft 等域名不会进入证书替换分支。本地集成测试用独立 TLS 服务验证其原证书能够端到端到达客户端；未执行真实账号登录。

证书按 RFC 5280 在 1950–2049 年使用 UTCTime，使用规范 DER INTEGER，附带 SKI/AKI，并以独立 OpenSSL `verify -x509_strict -purpose sslserver`、错误主机名和错误根证书测试验证。

## 一手资料

- [Prism 源码](https://github.com/PrismLauncher/PrismLauncher/tree/899d2f3957215a09fe398a8a8cbb8a8a9c619968)
- [Prism 元数据生成器](https://github.com/PrismLauncher/meta/tree/9cac2ca1cf410146d3a04fbd33752820fefdd70e)
- [Prism 元数据/API 设置说明](https://prismlauncher.org/wiki/help-pages/apis/)
- [BMCLAPI 官方文档](https://bmclapidoc.bangbang93.com/)
- [MCIM 当前指南](https://www.mcimirror.top/guide/start/getting-started)
- [MCIM CurseForge 规则](https://www.mcimirror.top/guide/platform/curseforge)
- [MCIM 源码](https://github.com/mcmod-info-mirror/mcim-rust-api/tree/db477f78e1317e2a90a6b72a34a50d7ac5509792)
- [MCIM 在线 OpenAPI](https://mod.mcimirror.top/openapi.json)
- [Modrinth 官方 API](https://docs.modrinth.com/api/)
- [CurseForge 官方 API](https://docs.curseforge.com/)

镜像内容完整性、稳定性和更新速度属于上游状态；测试通过反映的是记录时的接口与样本，不表示上游永远可用。
