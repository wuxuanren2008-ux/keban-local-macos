# 课伴本地端部署

桌面版复用网页版的课堂、文件学习、资料库、术语、复习和导出界面。录音由本机麦克风采集，Whisper 转写，Ollama 中的本机 LLM 翻译与总结。

## 第一次使用

1. 安装 Windows x64 安装包，双击桌面的“课伴”。免安装版本可直接打开。
2. 设置 → 本机模型与学习设置 → 一键准备 Ollama。首次约需下载 1.5 GB 的运行环境，网络中断后可重试。
3. 选择 Qwen3.5 4B，下载 LLM；选择 Whisper small，下载 / 准备 Whisper。准备完成后可断网使用。
4. 创建课程，为每节课填写名称，开始课堂。首次请允许软件使用麦克风。
5. 结束后等待尾句确认。录音、原文、译文和个人笔记按课程保存；再生成课堂总结，在“导图”中查看结构与字幕来源。

默认 CPU Whisper 不需要 CUDA。Qwen 由 Ollama 根据硬件分配 GPU/CPU。建议 16 GB 内存并预留 12 GB 以上磁盘空间；模型尺寸、缓存和课堂录音会持续占用空间。显卡模式需要兼容的 NVIDIA 驱动、CUDA/cuDNN，若加载失败请切回 CPU。普通笔记本的生成速度需要实测；处理跟不上时先保留录音。

## 课程学习怎样改善输出

在字幕中修正原文与译文，或者手动添加专业术语。总结页可保存已确认的遗漏重点、概念纠正或整理方式。只有这些确认过的内容进入当前课程的学习库。识别参考正确的专业词，翻译与总结参考译法和纠错例，总结还参考课程重点建议。课程间隔离，设置中可关闭学习、导出或重置。

这会改变下一次推理所参考的上下文，不会自动修改 Whisper/LLM 的模型权重。模型自产的文字没有经过确认时不进入训练集，避免错误循环积累。未来微调可使用导出的确认对，但需要独立留出验证集比较准确率后再替换模型。

## 文件学习与学术总结

TXT、Markdown、DOCX、PPTX 在本机提取文字；PDF 在本机提取可选中文本。扫描 PDF 没有文本时会明确提示，当前版本不具备 OCR；图片、表格和复杂公式请对照原文件。长资料分段处理后合并，失败的部分保留进度，不作为完整分析。

文献总结围绕研究问题、方法、结果与证据、局限组织；课堂总结围绕概念、知识关系、重点和自测问题。导图节点可定位对应字幕。模型仍可能遗漏或误解，来源回查与纠错用于改进实际课程表现。

## 数据位置与备份

Windows 应用资料位于 `%APPDATA%/lecture-companion-desktop/classroom-data`（设置中显示实际路径）。SQLite 保存课堂文字与总结，audio 目录保存录音。软件卸载不主动删除学习资料。可导出课堂 JSON、字幕、讲义与导图；完整迁移时先正常退出，再备份整个 classroom-data 目录。文件学习结果另保存在桌面应用的 IndexedDB 中，迁移请导出其 JSON，或备份整个应用 userData 目录。

模型文件在 Ollama 与 Hugging Face 的用户缓存目录中，源码仓库和安装程序不附带模型权重或个人课程数据。

## 开发与构建

需要 Windows、Python 3.12、Node.js 24 和 npm。

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r desktop/requirements.txt pytest pyinstaller
npm ci
.venv/Scripts/python scripts/prepare_desktop.py
npm start
```

```powershell
.venv/Scripts/python -m pytest tests/test_local_runtime.py -q
npm test
./scripts/build-desktop.ps1 -SkipInstall
```

GitHub Actions 可手动构建。推送 `desktop-v*` 标签后构建 Windows 安装包并附到 Release。模型准备依赖官方 Ollama 下载地址与 Hugging Face；推理接口固定在本机 127.0.0.1，无 Gemini/Supabase 服务要求。
