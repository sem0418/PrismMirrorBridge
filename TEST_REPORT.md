# v1.0.3 候选验证

本轮先检查 Linux 上的核心和完整启动链路，再用实际 Windows 虚拟机运行官方 Prism 11.1.1 验证新设备 Java 自动安装。正式支持平台仍为 Windows x64；本候选尚未替换公开 v1.0.2。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Linux 自动化回归 | 85 通过、0 失败 | 包含大批 ID、超时、失败批次、TLS、凭据隔离、配置恢复及 Java 新增回归 |
| CLI 生命周期 | 通过 | 接入、隔离元数据、修复、撤销、启动及 doctor |
| 真实联网检查 | 32/32 通过 | BMCL 组件、MCIM API/文件、客户端/资源/原生库哈希、Java 原清单哈希；`test-results/live-report.json` |
| Java 各大版本 | 5/5 通过 | 8、16、17、21、25；恢复原清单哈希并通过原始 Prism 解析器；`native-java-report-1.0.3.json` |
| 冷 LWJGL 3.3.3 | 通过 | 没有预热 Minecraft 组件时也从 BMCL 正确转换；`cold-lwjgl-live-1.0.3.json` |
| Linux 游戏文件 | 通过 | 3888 个资源、资源索引、客户端及 57 个库 JAR SHA1；`linux-cold-start-1.0.3.json` |
| Linux 最终代码复启 | 通过 | 实际 Minecraft 1.21.1 Demo 主菜单，桥接器错误 0；`linux-final-launch-1.0.3.json` |
| Windows 回归 | 83 通过、2 跳过、0 失败 | 两项历史 POSIX 专用检查跳过 |
| Windows Prism 自动 Java 安装 | 通过 | 402 文件 SHA1 全部匹配，实际执行下载的 OpenJDK 21.0.7，退出码 0；`windows-java-1.0.3.json` |

表中 JSON 证据均位于 `test-results/`。Windows 实际运行：[42485444928](https://github.com/sem0418/PrismMirrorBridge/actions/runs/42485444928)，生产代码提交 `161690d70f8c8f90e82024a8602cb962eceb1bf4`。之后的交付整理仅更新文档和结果记录；最终 ZIP 另做清单、CRC、每文件哈希、官方 Node.exe 哈希及解压后回归检查。

本次修复及序列化、重复 Java 文件和 429 的原始证据见 [完整诊断](docs/COLD_START_501.md)。Windows 对照中 1.0.2 在 Minecraft/LWJGL 元数据成功后连续三次 Java 索引 501；1.0.3 对相同启动路径返回完整有效元数据，并完成 Java 安装。Java 21 的 402 个文件条目中有 205 次重复小文件请求复用了缓存；没有改成官方文件兜底。

Linux 冷下载实验从空目录开始，在 421 秒测试预算后中断，再仅复用本实验文件继续；第二阶段 1131 秒后完成并进入游戏欢迎界面。期间有 116 次上游临时镜像错误，重试后成功，不能称为全程无网络错误。最终代码另行复启，目视进入试玩主菜单，并重新核对完整资源及客户端哈希。

Linux 使用已有 Java 21.0.13；它不能替代 Windows 自动下载验证。Windows 测试在自有可销毁虚拟机中临时加入并移除测试 CA，始终保持 TLS 验证；未验收普通用户的 CurrentUser 证书确认对话框。没有改动原启动器或伪造账号，Linux 使用官方试玩流程。游戏内 Microsoft 公钥和个人资料请求在受限环境中存在 DNS 错误，登录、联机和用户账号均不在通过范围内。

**用户新设备、Windows 完整 ATM10 导入并进入游戏：未实机验证。** 不把上述结果等同于全部游戏版本、所有整合包和所有网络均成功。继续由用户试用候选包，确认后再更新正式发布。

历史 1.0.2 报告见 [历史验证](docs/VALIDATION_1.0.2.md)。
