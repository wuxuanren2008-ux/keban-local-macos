# 双语字幕浮窗（Windows / macOS 共用）

> Codex 集成复验：增加自定义状态文字显示；Windows 真实 Electron 测试发现 floating 层级未保持置顶，改为 screen-saver 并在显示后重设。独立的原生系统声音测试已覆盖实时 Whisper/LLM、置顶、隐藏/重开、暂停与音轨释放。下文保留 WorkBuddy 原始模块验收边界。

本模块提供一块**独立的、始终置顶的桌面字幕浮窗**，把课堂的原文与译文以高对比两行显示，
供 Windows 与 macOS 共用。系统音频捕获与主窗口集成由另一份工作（Codex）负责；本模块只负责
**浮窗本身**：创建、定位、文本更新、隐藏、销毁。

## 交付物

| 文件 | 作用 |
|---|---|
| `desktop/subtitle-window.cjs` | 主进程模块，导出 `createSubtitleWindow` |
| `desktop/subtitle-preload.cjs` | 浮窗 preload，暴露受限 API |
| `desktop/subtitle.html` | 浮窗文档（渲染 + 控件） |
| `tests/subtitle-window.test.cjs` | 模块测试（Node 原生 test，mock Electron） |

## 模块契约

```js
const {createSubtitleWindow} = require('./desktop/subtitle-window.cjs');

const subtitle = createSubtitleWindow({BrowserWindow, screen, ipcMain, owner, origin});

subtitle.show();                       // 创建或显示浮窗
subtitle.update({                      // 推送字幕内容
  original: 'Opportunity cost is the value of the next best alternative forgone.',
  translation: '机会成本是放弃的次佳选择的价值。',
  status: 'translating',               // idle | listening | recognising | translating | error
  language: '英语 → 简体中文'            // 可选，显示在状态行
});
subtitle.hide();                       // 隐藏浮窗（课堂继续）
subtitle.destroy();                    // 真正销毁并解绑监听
```

依赖通过参数注入（`BrowserWindow` / `screen` / `ipcMain`），因此本模块不直接 `require('electron')`，
既便于测试，也不绑定 Electron 版本。

### `show()`

- 首次调用创建浮窗；再次调用**复用同一窗口**并重新定位、`showInactive()`。
- 窗口属性：`frame: false`、`resizable: true`、`movable: true`、`skipTaskbar: true`、
  `alwaysOnTop`。定位到**课堂窗口所在显示器**工作区的**底部居中**（保留用户已调整过的尺寸）。
- **不抢焦点**：使用 `showInactive()`，课堂窗口保持在前台。
- **macOS 跨空间**：`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`，
  窗口类型为 `panel`，因此在其它 Space 与全屏应用之上仍可见。
- 加载本模块同目录的 `subtitle.html`，preload 为 `subtitle-preload.cjs`。
- `webPreferences`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。

### `update(payload)`

- 接受 **original / translation / status / language**。
- 文本做空白折叠（连续空白压成单空格、去首尾）并**硬截断到 1200 字符**，
  防止单个超长段落把浮窗撑开。
- `status` 只接受白名单值，其余回落到 `idle`；非字符串字段安全归一化为空串。
- 通过 `subtitle:update` 发给浮窗，并**缓存最新 payload**。
- 每次文档加载完成（`did-finish-load`）都会**重发最新 payload**，
  因此晚加载、重载或崩溃恢复后都不会显示空内容或旧内容。
- 在 `show()` 之前调用是安全的：不创建窗口，payload 被缓存，待加载后送达。

### `hide()` / `destroy()`

- `hide()` 仅隐藏窗口，**不停止课堂**；在 `show()` 前或 `destroy()` 后调用均安全。
- `destroy()` 销毁窗口、移除全部 IPC 监听与 owner 监听；可重复调用。
- `close` 事件被 `preventDefault()` 并转为 `hide()` —— 用户点关闭只会隐藏浮窗。
  真正销毁只经 `destroy()` 或 owner 关闭。
- 销毁后再次 `show()` 会**重建**窗口（覆盖渲染进程崩溃的场景）。

### 浮窗 → 主进程 IPC（白名单，仅两条）

| 通道 | 语义 |
|---|---|
| `subtitle:hide` | 隐藏浮窗（不停止课堂） |
| `subtitle:owner` | 显示并聚焦课伴主窗口 |

两者**均校验 `event.sender === 浮窗自身的 webContents`**，来自其它渲染进程、伪造 sender
或缺失 sender 的调用一律忽略。

### 安全边界

- 浮窗**不接触**会话 token、本地运行时（`127.0.0.1:8766`）、Supabase 或任何网络来源。
- 页面用 `textContent` 渲染，**从不使用 `innerHTML`**，因此字幕文本无法变成标记。
- `setWindowOpenHandler` 一律 `{action:'deny'}`；`will-navigate` 一律 `preventDefault()`。
- 文档 CSP 为 `default-src 'none'`；拖放事件被拦截，避免拖入文件触发导航。
- **不实现点击穿透**（有意为之）：穿透会导致浮窗上的控制按钮无法点击。

### 浮窗 UI

- 顶部：状态文本（含语言）＋ `A− / A+` 字号调节（14–64px，步长 2）＋「隐藏浮窗」＋「返回课伴」。
- 中部：原文（浅色高对比）与译文（暖黄色高对比）两行，各最多两视觉行，超出省略。
- 顶部与文本区为拖动区（`-webkit-app-region: drag`），按钮为 `no-drag`，窗口边缘可缩放。

## 测试

测试使用 **Node 原生 `node:test`**，通过注入手写的 `BrowserWindow / screen / ipcMain`
假对象运行，**不需要 Electron 二进制**。

```powershell
node --test tests/subtitle-window.test.cjs
```

覆盖内容：

- **options**：frameless、可拖动、可缩放、alwaysOnTop、`showInactive`（且不调用 `show`）、
  `skipTaskbar`、加载 `subtitle.html`、preload 路径、`contextIsolation/sandbox/nodeIntegration`。
- **定位**：底部居中；跟随 owner 所在显示器（多屏）；重复 `show()` 复用同一窗口。
- **文本更新**：`subtitle:update` 送达；白名单 status 回落；空白折叠与 1200 字符截断；
  `did-finish-load` 重发**最新**（而非最早）payload；`update()` 无参不抛错。
- **IPC 拒绝**：伪造 sender / 空 sender / 缺 sender 的 `subtitle:hide` 与 `subtitle:owner` 被忽略；
  合法 sender 生效且 `hide` 不销毁窗口。
- **close / hide / destroy**：`close` 被阻止并转为隐藏；`hide` 在 show 前与 destroy 后均安全；
  destroy 幂等、解绑 IPC 与 owner 监听；destroy 后 `show()` 抛错；窗口被销毁后 `show()` 重建。
- **owner 生命周期**：owner 关闭时浮窗自动销毁；owner 已销毁后不再聚焦。
- **导航锁定**：window-open 返回 `deny`；`will-navigate` 被阻止。
- **参数校验**：缺少 BrowserWindow / screen / ipcMain / owner 时抛出明确错误。

## 集成（供主窗口侧参考）

主窗口侧只需在 `app.whenReady()` 之后传入自身的 Electron 依赖与课堂窗口：

```js
const {createSubtitleWindow} = require('./desktop/subtitle-window.cjs');
const subtitle = createSubtitleWindow({BrowserWindow, screen, ipcMain, owner: window, origin});
// 字幕到达时：
subtitle.update({original, translation, status: 'translating', language: '英语 → 简体中文'});
// 别忘了在退出时：subtitle.destroy();
```

系统音频捕获如何把识别结果送到 `update()` 属 Codex 负责的集成范围。
本模块**不**注册全局快捷键、**不**读取音频、**不**访问运行时。

## 测试结果（本次实际执行）

平台：**Windows 11 (10.0.22631) / AMD64**，Node `v22.22.2`。

```
$ node --test tests/subtitle-window.test.cjs
1..23
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```
$ npm test          # 新增用例与既有套件一起跑
1..33
# tests 33
# pass 33
# fail 0
```

开发过程中测试真实捕获并修掉了两个缺陷：

1. `placeBottomCentre` 误把**显示器对象**当作窗口调用 `getBounds()/setBounds()` → 已改为
   从浮窗读取尺寸、对浮窗设置边界。
2. `destroy()` 中 `unmount()` 以 `ownerAlive()` 为条件移除 owner 监听，owner 已销毁时监听残留
   → 已改为无条件解绑。

## 限制与未验证部分

- **未在真实 Electron 中启动过浮窗**：本机未运行 Electron 端到端（`subtitle.html` 的实际渲染、
  `-webkit-app-region` 拖动、`alwaysOnTop` 层级、macOS `panel` 跨全屏行为均**未实机验证**）。
  测试为模块逻辑级，不含真实窗口系统。
- **macOS 行为未经原生验证**：`setVisibleOnAllWorkspaces`、`type: 'panel'`、
  `showInactive` 的跨 Space/全屏表现需在 macOS 由 GitHub runner 或实机确认。
- **DPI / 多显示器缩放**未覆盖：仅验证了按 workArea 计算坐标的逻辑。
- **系统音频捕获集成**不在本模块范围（Codex 负责），因此「字幕如何到达 `update()`」链路未联调。
- 未验证 `hide()` 后再次 `show()` 时用户手动调整过的尺寸在重启间是否保持（当前仅在同一会话内保持）。
