# 系统声音与双语字幕浮窗实施计划

**目标：** Windows 与 macOS 本地播放的视频、直播声音经本机 Whisper / LLM 形成置顶双语字幕，继续按课程保存音频、译文和总结。

**架构：** 复用现有课堂录制、识别、翻译与保存链路；增加麦克风/系统声音选择。Electron 授予受控 getDisplayMedia 请求，只把音轨送入识别和录音。浮窗通过受限 IPC 接收文本，无本机 API token，无模型调用权限。

**执行：** 使用当前可用工具直接逐项实施；WorkBuddy 负责独立浮窗模块，Codex 集成与复验。

## 约束与验收重点

- Windows 保持原 appId / userData，Mac 保持原 appId；不搬迁用户课堂资料。
- macOS 系统音频最低 14.2；其他课堂功能保持 14.0。macOS 15 使用系统捕获选择器。
- 只保存音频，不保存屏幕画面；授权拒绝、无音轨、静音均明确提示。
- 录制启动锁、停止尾句、切课、窗口关闭必须释放捕获，避免双重录制。
- 字幕严格对应同一原文，不把上一句译文配到下一句；只发送必要文本。
- 实际系统 loopback 与合成 MediaStream 测试分别标记，不能互相替代。

## 任务

- [x] WorkBuddy：创建 desktop/subtitle-window.cjs、subtitle-preload.cjs、subtitle.html 及独立 tests/subtitle-window.test.cjs。接口 createSubtitleWindow({BrowserWindow,screen,ipcMain,owner,origin}) → {show(),update({original,translation,status,language}),hide(),destroy()}；主窗校验由 Codex 负责。
- [x] Codex：新增系统捕获策略与测试，改 main/preload 权限和 IPC；补 macOS Info.plist 音频用途声明。
- [x] Codex：新增 frontend/system-subtitles.js，修改 local.js start(preparedStream) 传递、退出清理与界面资产构建。
- [x] 验证：协议、权限、关闭释放、浮窗同步；运行后端与前端回归，Windows 受控声音实际 loopback，macOS 两架构原生构建与测试。
- [x] 两仓库同步公共实现、更新使用说明与版本；验收通过后发布两版安装包和准确的测试范围。
