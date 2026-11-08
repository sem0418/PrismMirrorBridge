# 第三方来源

本项目源码按 GPL-3.0-only 分发，完整文本见 `LICENSE`。

## Prism Launcher 元数据规则

`data/library-patches.json`、`data/legacy-overrides.json`、`data/legacy-services.json` 来自 PrismLauncher/meta：

- 仓库：https://github.com/PrismLauncher/meta
- 提交：`9cac2ca1cf410146d3a04fbd33752820fefdd70e`
- 原文件：`meta/common/mojang-library-patches.json`、`mojang-minecraft-legacy-override.json`、`mojang-minecraft-legacy-services.json`
- 原项目许可：GPL-3.0；其历史包含 MultiMC Contributors 的 Apache-2.0 许可工作。
- 部分兼容转换行为参考该仓库 `generate_mojang.py`、`generate_fabric.py`、`generate_quilt.py`、`generate_forge.py`、`generate_neoforge.py`。

Prism Launcher Copyright (C) Prism Launcher Contributors；其所包含的 MultiMC 工作版权归 MultiMC Contributors。相关作者和具体版权声明以原文件和原项目为准。本项目不是 Prism、Mojang、Microsoft、BMCLAPI 或 MCIM 的官方产品。

## Node.js 便携运行时

Windows 包附带 Node.js v24.22.2 x64。官方分发包已与同一官方发布目录的 SHA256 清单核对：

```text
ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2  node-v24.22.2-win-x64.zip
```

来源：https://nodejs.org/dist/v24.22.2/

Node.js 和所包含组件的完整版权与许可证见 `runtime/NODE-LICENSE`。Source-only 包不附带运行时。

## 在线镜像及测试样本

BMCLAPI：https://bmclapi.bangbang93.com/ 及 https://bmclapidoc.bangbang93.com/

MCIM：https://www.mcimirror.top/ 及 https://github.com/mcmod-info-mirror/mcim-rust-api

`tests/fixtures` 为接口响应或 installer 中的 JSON 描述，用于离线兼容测试；不包含 Minecraft 客户端、模组或 Forge/NeoForge 安装器 JAR。个别测试描述去掉了图标等无关大字段。游戏、模组和其他第三方内容的权利归各自作者及平台所有。

ForgeWrapper 在运行时按元数据从 Prism 支持源获取，未把其 JAR 打包进本项目。其来源：https://github.com/ZekerZhayard/ForgeWrapper 。
