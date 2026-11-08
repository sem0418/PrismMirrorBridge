# 更新记录

## 1.0.0 — 2026-11-08

- 独立提供 BMCLAPI → Prism 组件元数据转换，覆盖 Minecraft、LWJGL、Fabric、Quilt、Forge 和 NeoForge。
- 将 Prism 模组 API、文件及 CurseForge 图标请求转交 MCIM，适配数字 ID、下载域名检查和项目摘要。
- 提供 Windows 接入、撤销、安装独立 CA 和便携 Node.js 运行时。
- 默认关闭 Prism 官方兼容配方及模组原源回退；支持同 BMCL 地址下的版本元数据备用路径。
- 修复 Linux GLFW split-native 补丁顺序、含空格版本号路由和严格 X.509 编码兼容性。
- 提供离线测试、在线下载哈希检查、原始 Prism 解析器诊断及 Windows/Linux/macOS CI。

测试范围和未验证项目见 [TEST_REPORT.md](TEST_REPORT.md)。
