# macOS 独立验收记录

日期：2026-10-13。实现与云端验证由 Codex 执行；WorkBuddy 通过原生桌面会话执行 Windows 回归、Playwright 等待参数复现，以及 GitHub 作业日志审查。两方执行平台分别注明。

## WorkBuddy 交付与独立复核

- 实际执行 Windows Python 回归：105 passed、1 skipped；跳过项为必须在 Darwin 执行的 CUDA 拒绝测试。
- 实际执行前端与平台测试：7/7 通过。
- 通过两组等待调用实际复现参数位置错误：错误调用约 30 秒超时，正确调用的约 8 秒参数生效。
- 读取原生作业产物，确认第一次绿色 CI 不包含完整 PASS。Codex 复核相同日志，并修复等待参数、退出码与结束标记检查。
- WorkBuddy 原始报告形成时修复后作业仍在进行，因此其旧运行结论作为历史审查记录，不能代替下面的最终验收。

## 已核验的原生运行

`38288633271` / `04deb218`：Apple Silicon 与 Intel 原生包均完成课堂保存、真实 Whisper、真实 LLM 总结、导图持久化、反馈记忆、术语与资料页面测试，产物中有完整 `PASS:` 行；Darwin 后端回归为 106 项通过，无跳过。

`38289383407` / `735cc53`：新增 Chromium 虚拟麦克风录音测试失败，没有字幕。该候选未发布。

`38291482998` / `ab0011a`：采集诊断显示 AudioContext 运行、Whisper 连接就绪，但虚拟机输入样本峰值为 0。该候选未发布。

`38293134744` / `ca1ed715` 的 Apple Silicon 与 Intel 作业均通过：使用明确的合成 MediaStream 替代虚拟机静音输入；真实 Whisper/LLM、AudioWorklet 与 MediaRecorder 落盘出现 `PASS capture:`，总结、导图、反馈与课程保存出现最终 `PASS:`。两个原生架构的安装包进入发行。

## 仍需实体 MacBook 验证

物理麦克风、首次 TCC 授权、Apple GPU 性能、长课堂、温度与电池表现，以及经过浏览器下载后的 Gatekeeper 用户体验。当前签名为 ad-hoc，未经过 Apple 公证。
