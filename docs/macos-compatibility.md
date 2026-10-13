# macOS 适配与验证边界

0.3.0 系统声音与双语浮窗更新：原生 arm64/x64 已通过 run 38336432144；各 108 项后端、36 项前端/权限/窗口测试，以及真实本机模型与右声道合成输入的完整字幕、录音保存和错误处理检查。详见[新增功能实测范围](subtitles-validation.md)。系统声音要求 macOS 14.2+；物理 MacBook 声音设备与首次授权仍需实机确认。

目标为 macOS Sonoma 14 或更新版本。Apple Silicon 使用原生 arm64 包，Intel 使用 x64 包；不能混用 Windows Python 冻结程序或依靠 Rosetta 验证替代原生 ARM 构建。

## 已确定的部署方式
- Electron 41.10.7；原生架构 Python 3.12 / PyInstaller 服务，不附带开发环境。
- faster-whisper 1.2.1、CTranslate2 4.8.2、AV 16.1.0。两种架构都有官方 Python 3.12 wheel。
- ONNX Runtime 使用 1.23.2；1.31.0 当前没有 Intel macOS wheel，不能直接沿用 Windows 锁文件。
- Whisper 为 CPU int8。Ollama 在具备能力的 Apple M 系列实机上支持 CPU/GPU，在 Intel 上使用 CPU。
- 小于 12 GB 内存的首次运行默认 Qwen3.5 2B，更多内存默认 4B。更大模型可手动选择；已保存的模型偏好不覆盖。
- 应用写入 `~/Library/Application Support/lecture-companion-macos/classroom-data`，原生包和用户数据分开。关闭窗口与 Cmd+Q 都先确认保存再停止服务。
- 包中包含麦克风用途声明与必要 Electron JIT 权限。macOS 实际麦克风授权仍由系统向用户请求；拒绝时应用提示位置，不改系统设置。

## 验证矩阵（2026-10-13）

| 环境 | 计划验证内容 | 结果 |
|---|---|---|
| GitHub macos-15 / arm64 | 原生 Python 测试、DMG/ZIP 构建、Mach-O 架构、签名完整性、真实 Whisper与LLM、合成 MediaStream 录音链路、Electron与归档 | 通过：run 38293134744，106 项后端、7 项前端／平台测试；完整捕获与总结 PASS |
| GitHub macos-15-intel / x64 | 原生包、Intel wheel、真实 Whisper/4B LLM、合成录音链路与归档 | 通过：run 38293134744，完整捕获与总结 PASS |
| 用户 Apple M 系列 MacBook | 物理麦克风、TCC首次授权、GPU推理、电池与课堂长时运行 | 未接触实体设备，待实测 |

GitHub 标准 macOS ARM 环境约 7 GB 内存，因此使用 2B 模型跑完整链路；Intel 环境使用 4B。平台级通过不等于两个模型在学术质量上相同，也不是 MacBook 性能基准。

当前为 ad-hoc 签名，未使用 Apple Developer ID 证书和公证服务。签名完整性通过只证明包结构未损坏，不等于 Apple 公证或 Gatekeeper 自动信任。不会移除 quarantine、禁用 Gatekeeper/SIP，或用未授权的 Windows macOS 镜像。

Apple Silicon 测试主机实际为 macOS 15.7.9、arm64、7 GB 内存。合成输入只替代虚拟机静音设备，不证明实体麦克风或 TCC 授权通过。完整日志和界面产物见 [原生测试作业](https://github.com/wuxuanren2008-ux/keban-local-desktop/actions/runs/38293134744)。

官方来源：[GitHub 标准运行环境](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Ollama macOS](https://docs.ollama.com/macos)、[CTranslate2 PyPI](https://pypi.org/project/ctranslate2/4.8.2/#files)、[ONNX Runtime PyPI](https://pypi.org/project/onnxruntime/1.23.2/#files)。
