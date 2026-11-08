# 验证报告

日期：2026-11-08（中国标准时间）。

**最终结果：43/43 项自动化测试、30/30 项真实联网检查、25/25 份原始 Prism 解析器样本、4/4 项 Qt 网络检查、7/7 项严格证书检查通过。官方 Prism 11.1.1 的 Linux 界面中实际下载了 4 个模组文件，全部哈希匹配。**

这证明了所列样本的转换及传输可行性，不能等同于全部版本、平台和模组组合均无误。Windows 信任/撤销脚本、真实账号登录、完整游戏安装及进入游戏尚未实机验收。

## GitHub 发布前补充验证

[CI 运行记录](https://github.com/sem0418/PrismMirrorBridge/actions/runs/42458302204)，对应代码提交 `e97bb869215d2a83c5157fa3ceb1290021771898`。使用 Node.js 24.22.2。

| 托管环境 | 43 项离线测试 | CLI 初始化、配置恢复、服务、doctor | 严格 X.509 |
| --- | --- | --- | --- |
| Windows | 通过 | 通过 | 不在该平台运行 |
| Linux | 通过 | 通过 | 通过 |
| macOS | 通过 | 通过 | 不在该平台运行 |

Windows 首轮在证书导入步骤挂起，未完成接入/撤销的证书信任验收；初始结果保留在 `test-results/github-ci-initial.json`。根证书首次导入可能需要 Windows 安全确认，托管 CI 不具备这项桌面交互条件。最终 CI 明确只验证无信任库改动的 CLI 生命周期，默认不导入证书；可在自己的 Windows 桌面运行 `node scripts/smoke-test.mjs --windows-trust` 额外验证。没有通过关闭 TLS 校验或跳过系统提示来伪造信任测试成功。

最终结构化结果见 `test-results/github-ci-report.json`。发布准备另核对远程每个文件的 Git blob SHA、提交邮箱、私密文件和默认配置。Windows/Linux/macOS 的核心检查通过，仍不代表 Windows 普通桌面接入、Microsoft 登录和进入游戏已完成验收。

## 运行环境与依据

- Node.js 24.22.1、Linux x86_64；Windows 包附带官方 Node.js 24.22.2 x64，已核对分发包和 node.exe 的 SHA256。最初本地 Windows 仿真未成功执行；本轮 Windows 托管 CI 已实际运行 Node.js 24.22.2，但仍不能代替普通 Windows 桌面和 Prism 的交互验收。
- 原始解析器来自 Prism 提交 `899d2f3957215a09fe398a8a8cbb8a8a9c619968`。交付的构建脚本实际重建成功；Prism 的解析源文件未修改，测试桩仅提供诊断显示名称。
- GUI 使用官方 Prism 11.1.1 Linux AppImage 中未修改的启动器二进制及其 Qt 6.10.2。AppImage SHA256：`bb81038c56a09e944659e4b808dbfbc52d52d5e3a3ffe32216689a3ca1508d3d`。
- Linux GUI 在隔离数据目录/Xvfb 中运行。测试辅助库通过 Qt 公共接口只添加本次安装 CA，保留正常证书链和主机名校验；未关闭 SSL 验证。此步骤只用于测试，不能替代 Windows certutil 实测。

## 自动化与严格证书检查

原始记录：`test-results/unit.tap`、`test-results/certificate-report.json`。自动化无失败、取消或跳过。

覆盖 Mojang 到 Prism 组件结构、Fabric/Quilt 依赖、现代和旧 Forge、NeoForge 26.x、split-native 原生库、启动参数、数字 ID 转换、HTML 摘要转义、HTTP CONNECT/TLS、错误主机/证书拒绝、身份服务加密透传、Range/206/HEAD、凭据隔离、重试/缓存合并、同 BMCL 镜像路径回退，以及配置原子写入与恢复。

证书另通过独立 OpenSSL 的 `verify -x509_strict -purpose sslserver`，验证错误主机名、错误根证书被拒绝，并检查 UTCTime 及 SKI/AKI。持续文件传输测试使用 2 秒数据流和 1 秒无进展超时，确认不会把总下载时长误当作空闲超时。

## 原始 Prism 解析与 Qt 网络

原始记录：`test-results/native-report.json`；25 份输入快照在 `test-results/native-cases/`，不包含第三方 JAR。

样本包含 Minecraft 1.5.2、1.7.10、1.12.2、1.16.5、1.20.1、1.21.1、26.3、3D Shareware v1.34 及对应 LWJGL 组件，Fabric 0.16.14/0.20.1、intermediary、Quilt、三种 Forge 和两种 NeoForge。全部由上游 `OneSixVersionFormat` 真实解析，检查组件身份和错误严重度。带空格的版本还经过真实 HTTP 编码路由。

记录附有 Windows amd64/aarch64、Linux amd64、macOS amd64/aarch64 的原始库规则计算结果；这些属于运行上下文模拟，不代表在这些系统上执行了游戏。

Qt 的 4 项检查是：本地元数据经 HTTP 代理读取、Modrinth API 的 TLS 校验、CurseForge 字符串 ID POST 转换、Microsoft 公共 OIDC 配置的加密透传。全部 HTTP 200、Qt 错误码 0。Qt 在错误码 0 时也可能返回 `errorString: Unknown error`，该字符串不表示请求失败。Microsoft 测试的上游网络代理证书未被本工具替换；没有使用账号或令牌登录。

## 真实联网检查

原始记录：`test-results/live-report.json`。最终完整一轮 30 项全部通过。测试显式关闭 `compatibilityRecipes` 与 `fileFallback`；Prism 官方兼容元数据请求为 0。

| 检查 | 结果 | 实际观测 |
| --- | --- | --- |
| Prism component index | 通过 | packages: 8 |
| BMCL Minecraft version list | 通过 | versions: 922 |
| BMCL Minecraft 1.20.1 conversion | 通过 | uid: net.minecraft, java: [17], mainJarSha1: 0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838 |
| BMCL LWJGL 3 native component | 通过 | libraries: 63 |
| BMCL Minecraft 1.12.2 | 通过 | java: [8], traits: [] |
| BMCL Minecraft 1.5.2 | 通过 | java: [8], traits: ["legacyLaunch", "texturepacks", "legacyServices"] |
| BMCL Minecraft 26.3 | 通过 | java: [25], traits: ["XR:Initial", "feature:is_quick_play_singleplayer", "feature:is_quick_play_multiplayer", "FirstThreadOnMacOS"] |
| BMCL Minecraft 3D Shareware v1.34 | 通过 | java: [8], traits: ["FirstThreadOnMacOS"] |
| BMCL component net.fabricmc.fabric-loader/0.16.14 | 通过 | libraries: 7, mavenFiles: 0, mainClass: net.fabricmc.loader.impl.launch.knot.KnotClient |
| BMCL component net.fabricmc.intermediary/1.20.1 | 通过 | libraries: 1, mavenFiles: 0 |
| BMCL component org.quiltmc.quilt-loader/0.23.0 | 通过 | libraries: 12, mavenFiles: 0, mainClass: org.quiltmc.loader.impl.launch.knot.KnotClient |
| BMCL component net.minecraftforge/10.13.4.1614 | 通过 | libraries: 18, mavenFiles: 0, mainClass: net.minecraft.launchwrapper.Launch |
| BMCL component net.minecraftforge/14.23.5.2860 | 通过 | libraries: 20, mavenFiles: 0, mainClass: net.minecraft.launchwrapper.Launch |
| BMCL component net.minecraftforge/47.3.0 | 通过 | libraries: 30, mavenFiles: 37, mainClass: io.github.zekerzhayard.forgewrapper.installer.Main |
| BMCL component net.neoforged/21.1.1 | 通过 | libraries: 45, mavenFiles: 86, mainClass: io.github.zekerzhayard.forgewrapper.installer.Main |
| BMCL component net.neoforged/26.3.0.101 | 通过 | libraries: 28, mavenFiles: 31, mainClass: io.github.zekerzhayard.forgewrapper.installer.Main |
| MCIM Modrinth search over CONNECT/TLS | 通过 | title: Sodium |
| MCIM Modrinth version filtering | 通过 | versions: 13 |
| MCIM CurseForge file metadata | 通过 | modId: 238222, fileId: 9394362, filename: jei-1.20.1-fabric-15.74.0.234.jar, downloadHost: edge.forgecdn.net |
| Prism string IDs to MCIM CurseForge bulk integers | 通过 | projects: 1 |
| MCIM CurseForge bulk file IDs | 通过 | files: 1 |
| CurseForge description adapts a real MCIM project summary | 通过 | source: mcim-project-summary, characters: 141 |
| MCIM CurseForge thumbnail via verified CONNECT TLS | 通过 | bytes: 16376, sha256: a77df0f11ffe974e1a03b607724099847ba9e928af5bfdc36d10795b874f59f7 |
| MCIM Modrinth JAR download and SHA512/SHA1 | 通过 | filename: sodium-fabric-0.5.11+mc1.20.1.jar, bytes: 968419, sha1: c4293c1483f3b39c1c6c4c69143e8bb2c6e53daf |
| MCIM CurseForge JAR download and SHA1 | 通过 | filename: jei-1.20.1-fabric-15.74.0.234.jar, bytes: 4865333, sha1: 7b971a4a1b529d5d2390ceb6eaa3255cd63cd62c |
| BMCL Windows native JAR and SHA1 | 通过 | library: org.lwjgl:lwjgl-glfw-natives-windows:3.3.1, bytes: 145512, sha1: ed892f945cf7e79c8756796f32d00fa4ceaf573b |
| Prism Linux GLFW compatibility JAR and SHA1 | 通过 | library: org.lwjgl:lwjgl-glfw-natives-linux:3.3.2-lwjgl.1, bytes: 115553, sha1: 0766bb0e8e829598b1c8052fd8173c62af741c52 |
| BMCL asset index and asset content SHA1 | 通过 | asset: icons/icon_128x128.png, bytes: 9101, sha1: b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356 |
| BMCL Minecraft client JAR download and SHA1 | 通过 | bytes: 23028853, sha1: 0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838 |
| Mainstream components do not use Prism metadata recipes | 通过 | compatibilityRequests: 0 |


## 官方 Prism 界面验证

原始记录：`test-results/prism-gui-report.json`。使用隔离目录中的最小 Minecraft 1.20.1 实例，在真实 Version 页读取转换后的版本列表和组件，使用 Install Loader 选择 Fabric 0.20.1，并自动解析 intermediary；组件显示正常。最终服务重启后清除测试实例的元数据缓存并复验，确认实际采用修正后的 Linux GLFW 兼容库。

在 Modrinth 搜索、查看版本并安装 Sodium；在 CurseForge 搜索 JEI、查看摘要与版本、确认依赖后安装 JEI、Fabric API 和 MezzConfig。最终界面显示 4 installed；这些文件由原版 Prism 自身下载，随后独立读取文件并对照实际 MCIM 响应校验哈希。

| 界面下载文件 | 来源接口 | 字节数 | SHA1 |
| --- | --- | ---: | --- |
| fabric-api-0.92.12+1.20.1.jar | curseforge | 2137232 | `3e9cdd3e2f827ca9a259df9eb8e31949437b6bd4` |
| jei-1.20.1-fabric-15.74.0.234.jar | curseforge | 4865333 | `7b971a4a1b529d5d2390ceb6eaa3255cd63cd62c` |
| mezz_config-1.20.1-fabric-0.6.11.jar | curseforge | 388759 | `11008d72e652faa4fc1c0740ada7f385ffe3f26d` |
| sodium-fabric-0.5.13+mc1.20.1.jar | modrinth | 971552 | `bcdbf37d9494e405cba210d7a80ed58e756297b5` |

Sodium 同时比对了 SHA512。最终界面验证期间服务 HTTP 错误计数为 0、官方兼容配方与原文件回退计数均为 0。

点击 Download all 后，原版 Prism 明确要求添加有效 Microsoft 账号，测试在此停止；未添加伪账号或绕过该检查。因此不能声称完整游戏下载、启动或游戏内运行已通过。

## 本轮发现并修复的问题

1. 原生库先匹配补丁再改名会遗漏 Linux GLFW 3.3.1 的兼容替换。现先规范 split-native artifact，再匹配补丁；替换 JAR 已真实下载并核对 SHA1。
2. 包含空格的 Mojang 版本 ID 曾被元数据路由拒绝。现允许一次正常 URL 解码，继续拒绝分隔符、控制字符、嵌套转义和路径穿越。
3. 证书有效期编码及密钥标识补齐到严格 X.509 校验要求。
4. BMCL `/version/<id>/json` 的部分短时错误可尝试同一 BMCL origin 下的 manifest 文件路径；不使用官方元数据回退，也不绕过 429。
5. MCIM 不提供 CurseForge 完整介绍，初次 GUI 检查会弹出 404 错误。现用 MCIM 真实项目摘要转换成 Prism 所需 HTML，并显式说明仅为摘要；空摘要和其他不支持接口仍报错。最终 GUI 复验正常。
6. CurseForge 图标域名 `media.forgecdn.net` 转交 MCIM，已用真实缩略图验证 TLS 和图像内容。按 MCIM 要求仍保留 `mediafilez.forgecdn.net`。

本轮早期联网检查曾遇到 BMCL HTTP 503，并导致依赖该元数据的后续文件检查失败。原失败记录保留在 `test-results/upstream-instability-observed.json`，没有改写成成功。修复及后续完整联网复验均通过，但镜像仍可能临时故障。

## 打包验证与未覆盖范围

打包后从 ZIP 解压到全新临时目录，检查 CRC、文件 SHA256 清单、私密状态排除、重新执行自动化及 CLI 初始化、配置/撤销、独立服务健康检查，结果见 `test-results/package-check.json`。

未覆盖：真实 Windows certutil/PowerShell 桌面执行；Microsoft 真实登录；完整游戏安装/进入游戏；大型整合包闭环；所有历史版本和模组组合；上游今后的稳定性。Java 自动下载等额外 Prism 描述只在用户显式开启兼容模式后提供。ForgeWrapper 或特定平台支持工件可能保留原源，因此不是每个网络字节都必然来自 BMCL/MCIM。

## 复现

```sh
node --test --test-reporter=tap --test-concurrency=1 tests/*.test.mjs
node scripts/live-test.mjs
node scripts/certificate-check.mjs
node scripts/build-native-probe.mjs --prism-source /path/to/PrismLauncher --qt-include /path/to/qt6 --out /tmp/prism-probe
node scripts/native-validation.mjs --probe /tmp/prism-probe
/tmp/prism-probe test-results/native-cases
```

深入解析测试需 GCC 14+ 和 Qt 6 开发依赖；普通使用只需随包 Node.js。GUI 复验需按系统给 Prism 配置信任本次 CA，在独立数据目录中按上述步骤操作。无测试账号时应停在游戏下载账号提示处。
