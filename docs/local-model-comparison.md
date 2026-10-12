# 本地模型选择

调研日期：2026-10-12。默认使用 Qwen3.5 4B，9B 为高配选项。选择依据是本机部署体积、多语言覆盖、中文课堂需求、结构化输出和分发许可；这是部署选择，尚未进行真实课程上与 Gemini 的盲评。

| 候选 | 在课伴中的用途与取舍 | 官方来源 |
|---|---|---|
| Qwen3.5 4B | 默认；本机 Ollama 已安装并完成经济学术语翻译、课堂总结与导图测试。建议 16 GB 内存。 | [Qwen 官方项目](https://github.com/QwenLM/Qwen3.8)、[4B 模型卡](https://huggingface.co/Qwen/Qwen3.5-4B)、[Ollama 标签](https://ollama.com/library/qwen3.5:4b) |
| Qwen3.5 9B | 更大模型的可选配置，需要更多资源；本次未下载实测，不保证学术总结必然更好。 | [9B 模型卡](https://huggingface.co/Qwen/Qwen3.5-9B)、[Ollama 标签](https://ollama.com/library/qwen3.5:9b) |
| Qwen3 8B | 已有 Qwen3 环境可复用；本次作为兼容选项，未实测对比。 | [Qwen3 官方项目](https://github.com/QwenLM/Qwen3)、[本地运行文档](https://github.com/QwenLM/Qwen3/blob/main/docs/source/run_locally/ollama.md) |
| Gemma3 4B | 多语言候选，保留切换选项；使用 Gemma 条款，不凭不同评测设置的分数断言不适合学术内容。 | [Gemma 官方项目](https://github.com/google-deepmind/gemma)、[模型卡](https://huggingface.co/google/gemma-3-4b-it) |

Qwen3.5 4B/9B 的官方发布日期为 2026-03-02。Qwen 使用 Apache-2.0，应保留许可与适用声明；Gemma 遵循自身条款。安装包不再分发模型权重。

## 当前实际配置

- Ollama v0.40.3；qwen3.5:4b，Q4_K_M 文本权重约 3.3 GB；下载内容可能另含视觉组件。
- Whisper small，faster-whisper CPU int8；已加载成功，录音识别通过本机服务。
- LLM 使用 think:false、JSON 输出、16K 推理上下文与明确的输入预算；不把模型公布的最大上下文当作笔记本可用上下文。
- 长课堂完整分块，然后层次合并。失败或超预算明确返回错误，不把截掉后半段的结果当完整总结。
- 学术资料提示词按研究问题、方法、结果、证据、局限组织，并保留来源。数值与引用仍需要对照原文。

## 持续改进与评测

课程术语与用户确认的纠错进入本机 SQLite，每次推理检索当前课程中相关的例子。关闭学习后不注入；可导出或重置。基础模型权重未自动更新。

正式比较时，对每门课保留未参与纠错的录音、人工原文和关键概念清单，分别评价 ASR 词错误率、翻译术语命中率、总结概念覆盖与错误断言、来源对应准确率，再决定是否换模型或进行受监督微调。不能将模型的旗舰版排行榜分数套用于 4B 量化版本，也不能将一次示例验证视作准确率提升证据。
