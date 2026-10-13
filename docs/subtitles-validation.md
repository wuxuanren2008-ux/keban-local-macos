# macOS 系统声音字幕验收（2026-10-13）

版本 0.3.0，原生验证提交 `6cd9841`，完整作业 [38336432144](https://github.com/wuxuanren2008-ux/keban-local-macos/actions/runs/38336432144)。

| 平台 | 后端 | 前端/权限/浮窗 | 原生应用 |
|---|---:|---:|---|
| macOS 15.7.9 / arm64，7 GB，Qwen3.5 2B | 108 passed | 36 passed | DMG/ZIP、签名、真实 Whisper/LLM、课堂回归及字幕链路通过 |
| macOS 15 / x64，Qwen3.5 4B | 108 passed | 36 passed | DMG/ZIP、签名、真实 Whisper/LLM、课堂回归及字幕链路通过 |

浮窗运行在真正的原生 Electron 中。系统音轨用测试专属 getDisplayMedia 合成输入替代 VM 的声音设备，左声道静音、右声道人声；通过生产 AudioWorklet 单声道混合、Whisper small / CPU int8、Qwen 翻译形成对应中英字幕。测试确认真实窗口置顶、隐藏/重开、暂停/继续、音频课程归档、停止后所有音轨 ended，授权拒绝及缺失音轨不会回退到麦克风。

原有课堂的真实识别、录音/字幕保存、总结与导图回读、术语、反馈学习和文献页均有最终 PASS。包中确认 NSAudioCaptureUsageDescription / NSMicrophoneUsageDescription，原生二进制架构、签名完整性和下载产物 SHA256 均经检查。

合成输入只用于自动化测试，不存在于交付的程序中。这里没有实测物理 MacBook 的系统音频设备、首次 TCC 授权、GPU/电池性能或所有浏览器/会议软件。首次仍需由用户通过 macOS 的正常授权流程允许课伴采集系统声音。系统声音最低 macOS 14.2，15+ 使用系统共享选择器；其他课堂功能仍支持 14.0+。

![Apple Silicon 原生字幕浮窗](subtitles-overlay.png)

Windows 0.2.0 已完成受控外部播放器的实际 WASAPI 回采，包括右声道人声，可查看 [Windows 实测报告](https://github.com/wuxuanren2008-ux/keban-local-desktop/blob/main/docs/subtitles-validation.md)。权限与媒体兼容性见 [使用说明](system-subtitles.md)。
