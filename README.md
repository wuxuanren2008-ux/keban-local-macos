# 课伴 macOS 本地端

适配 Apple M 系列 MacBook，提供原生 arm64 `.app`、DMG 与 ZIP；Intel 使用单独的 x64 包。录音、Whisper 转写、LLM 翻译、课堂总结、思维导图与课程纠错学习在本机运行。

[下载 macOS 版本](https://github.com/wuxuanren2008-ux/keban-local-macos/releases/latest) · [兼容性与测试证据](docs/macos-compatibility.md)

0.3.0 新增视频与直播的本机系统声音翻译、置顶双语字幕浮窗，支持英译中 / 中译英。使用方法与权限说明见[系统声音字幕](docs/system-subtitles.md)；系统声音需要 macOS 14.2+。

## 安装与使用

1. Apple M1/M2/M3/M4 等机型选择文件名含 `arm64` 的 DMG。Intel 机型选择 `x64`。
2. 打开 DMG，将“课伴macOS”拖到 Applications，再启动应用。
3. 设置 → 本机模型与学习设置 → 一键准备 Ollama，下载所选 LLM 和 Whisper。首次需要联网，之后可离线推理。
4. 创建课程，填写每节课名称，开始课堂；macOS 会请求麦克风授权。
5. 结束并等待尾句确认后生成总结。在“导图”中查看知识关系并定位字幕，在“我的课堂”中回听录音。

需要 macOS Sonoma 14 或更新版本；原生测试环境的具体版本见测试报告。建议 16 GB 内存、至少 12 GB 空闲磁盘。首次运行时，低于 12 GB 内存默认使用 Qwen3.5 2B，更多内存默认 4B；可以手动选择其他本机模型。Intel 使用 CPU，处理长课的速度需要按具体机型评估。

Whisper 使用 CPU int8；Apple GPU 加速由 Ollama 为 LLM 提供，不能把它称为 Whisper Metal 加速。课伴本轮没有加入 MLX ASR。

当前为 ad-hoc 签名，没有 Apple Developer ID 证书和公证。macOS 对通过浏览器下载的应用可能显示安全提示；是否允许运行由用户通过系统正常授权流程决定。项目不提供关闭 Gatekeeper/SIP、移除 quarantine 或改写系统安全设置的脚本。

## 功能与课程学习

- 课堂双语字幕、暂停/继续、重点标记、原文与译文纠错、录音回听及导出。
- 学术总结、术语卡片、自测问题与带字幕来源的知识导图。
- 课程分类保存录音、文字、总结、导图和笔记。
- 保存确认的术语、译文纠错和总结重点建议，后续推理按课程检索参考；支持关闭、重置与导出。
- 文件学习支持文本型 PDF、TXT、Markdown、DOCX、PPTX；扫描 PDF 的 OCR 尚未实现。

学习改变的是推理时参考的课程上下文，没有自动微调基础模型权重，也不会把未确认的模型输出当作正确答案训练。

资料位于 `~/Library/Application Support/lecture-companion-macos/classroom-data`，设置中显示实际位置。模型在 Ollama 与 Hugging Face 的用户缓存目录中。文件学习的 IndexedDB 结果需导出其 JSON，或在退出后备份整个应用 userData 目录。发布包不包含个人课程数据或模型权重。

## 开发与原生构建

在对应架构的 Mac 上，准备 Python 3.12、Node.js 24 与 npm：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r desktop/requirements-macos.txt
npm ci
node node_modules/electron/install.js
.venv/bin/python scripts/prepare_desktop.py
npm start
```

```bash
.venv/bin/python -m pytest tests/test_local_runtime.py tests/test_macos_runtime.py -q
npm test
bash scripts/build-macos.sh --skip-install
```

ARM 与 Intel 必须分别构建，Python 服务和 Electron 的 CPU 架构一致。GitHub 工作流使用原生 macOS 运行环境，验证构建、签名完整性、真实模型以及合成音频的录音链路；实体 MacBook 的物理麦克风、首次 TCC 授权、电池和长课堂仍需实机验证。
