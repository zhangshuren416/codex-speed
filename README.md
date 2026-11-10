# Codex Speed

Codex / ChatGPT 桌面应用的本地速度计：读取会话日志，显示每轮回答的 tok/s、首 token 延迟、平均 token 间隔和推理占比，提供 **Codex 会话右侧速度面板**、**Windows 悬浮窗** 和 **浏览器面板**。

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933)
![platform](https://img.shields.io/badge/platform-Codex%20Desktop%20%7C%20Windows-0078D4)

> Codex 只在响应结束后写入 token 用量，所以速度是**每次响应 / 每轮回答的平均值**，不是逐 token 实时值。

## 功能

- 每轮/会话 tok/s、输出 tokens、首 token 延迟、平均 token 间隔、推理占比
- 最近几轮摘要、最近会话对比
- Codex 会话右侧速度面板、Windows 置顶悬浮窗、浏览器面板
- 每个面板按 threadId 绑定自己的会话，多开窗口不会串数据
- 查询默认跟随当前会话，也可显式钉住 / 取消钉住其他会话
- 只读本地日志，零 npm 依赖，完全离线，不需要 API Key

## 安装

需要 Node.js 18+、支持 MCP Apps thread entrypoint 的 Codex Desktop（速度面板）；HUD 仅支持 Windows。

```powershell
git clone https://github.com/zhangshuren416/codex-speed.git
cd codex-speed
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Enable
```

重启 ChatGPT / Codex，在 **Plugins → Personal** 中启用 **Codex Speed**。

新版 Codex 会在每次工具调用里注入当前会话的 `threadId`，面板默认就按它精确取数，不依赖 hooks。只有在宿主不提供 `threadId` 的旧版本/特殊调用里，才会用 `SessionStart` / `UserPromptSubmit` / `Stop` hooks 作为兜底；需要时可到 **Review hooks** / **Settings → Hooks** 信任它们。

## 使用

### Codex 速度面板（推荐）

打开任意会话，点击会话右侧的 **「速度面板」** 标签页。面板打开后会常驻并每秒自动刷新，**之后每轮回答结束都会更新，不需要再发 prompt**。

面板严格按当前会话的 `threadId` 取数：每个会话有自己的面板实例，多开窗口不会串数据。如果当前会话还没有落盘日志，面板会显示等待，发一条消息后自动开始。

> Codex 目前不允许模型自动打开侧面板，所以不要对助手说「打开面板」来期待侧面板；请在界面上手动点开。该入口是 app-only，模型看不到这个工具，也就不会在对话里内联渲染。

### 对话 / HUD / 浏览器

```text
看一下现在推理多快
刚才那轮多快
最近哪个会话最快
钉住 01a1c362 这个会话
恢复自动跟随
```

上面这些查询默认读取**当前会话**；只有显式说「钉住 <会话 id>」才会查别的会话。侧面板不受钉住影响，始终显示自己所属的会话。

```text
打开速度悬浮窗
关掉速度悬浮窗
```

HUD 支持拖动、置顶、透明度和缩放，右键菜单或 `Esc` 关闭。

浏览器面板地址：`http://127.0.0.1:<port>/panel`（端口通常是 `8787`，被占用时顺延；具体见 `get_reasoning_speed` 的 `hud.port`）。

工具：`get_reasoning_speed`（查询/钉住会话）、`list_recent_sessions`、`show_speed_hud`、`hide_speed_hud`。`show_speed_panel` 和 `get_speed_snapshot` 是面板内部工具（app-only），模型不会调用。

## 指标

- `live.tokensPerSec`：最近 3 次响应加权速度
- `turn.avgTokensPerSec`：本轮平均速度，不含工具等待
- `turn.wallTokensPerSec`：整轮墙钟速度，含工具等待
- `turn.timeToFirstTokenMs` / `turn.avgMsPerToken`：首 token 延迟 / 平均 token 间隔
- `turn.reasoningShare`：本轮推理 token 占比
- `threadId`：Codex 注入的当前会话 id；面板和默认查询按它精确取数，不会退回其他会话

一轮回答可以包含多次模型响应和工具调用；响应速度按“每次响应”采样。

## 限制

- 只读 `~/.codex/sessions`、`~/.codex/archived_sessions`，不修改会话文件
- 默认只读日志末尾 12 MB（最近会话列表 4 MB），超长会话的均值只覆盖窗口内样本
- 速度面板需要支持 MCP Apps thread entrypoint 的 Codex Desktop，且只能由用户手动打开；HUD 仅支持 Windows
- 面板只读取其所属会话；当前会话还没有日志时会显示等待，不会拿别的会话顶替
- 日志格式可能随 Codex 版本变化，速度是本地推算值


## License

MIT