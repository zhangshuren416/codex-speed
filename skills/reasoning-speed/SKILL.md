---
name: reasoning-speed
description: 查看 Codex 会话的实时推理/输出速度（tok/s）、推理 token 占比与历史会话速度对比。当用户问“现在推理多快”“速度多少”“为什么变慢了”“开个速度悬浮窗”时使用。
---

# 推理速度

用 `codex-speed` 插件提供的工具读取本地会话日志并汇报速度。

## 何时调用

| 用户说法 | 调用 |
| --- | --- |
| 现在推理多快 / 速度多少 / tok/s 多少 / 是不是卡了 | `get_reasoning_speed` |
| 刚才那轮多快 / 这轮花了多少 token | `get_reasoning_speed`（看 `turn`） |
| 最近哪个会话最快 / 对比一下 | `list_recent_sessions` |
| 想在 Codex 会话右侧看实时面板 | 不要调用工具；让用户手动点击会话右侧的「速度面板」标签页（app-only entrypoint，模型看不到） |
| 开个悬浮窗 / 想一直看着速度 / 关掉浮窗 | `show_speed_hud` / `hide_speed_hud` |
| 之前钉住了某个会话，想恢复自动跟随 | `get_reasoning_speed`，`session: "auto"` |

## 汇报口径（重要）

数据来自 `~/.codex/sessions/**/rollout-*.jsonl`，因此必须按下面的口径解释，不要夸大精度：

- **一次响应一条样本**。Codex 只在一次模型响应**结束后**才落盘 token 用量，流式增量事件不写文件。所以不存在逐 token 的实时速度，工具给的是“最近一次响应的平均速度”。
- **实时速度** `live.tokensPerSec` 是**输出**速度，包含思考（reasoning）与正文，不是纯“打字速度”。它是最近 3 次响应按 token 加权的平均。
- **单次响应** `live.lastResponse.tokensPerSec = outputTokens / seconds`，`seconds` 从“提示就绪（用户消息 / 工具结果 / 上一次响应结束）”算到“响应结束”，包含首 token 前的排队与预填充延迟。
- **纯生成速度** `live.lastResponse.genTokensPerSec` 用条目自身耗时（`Reasoning` / `AgentMessage` 的 `started_at_ms`→`completed_at_ms`）作分母。条目只覆盖一次响应的一部分生成过程，所以这个值普遍高于端到端速度（实测中位数约 1.9 倍），只作参考，不要拿它当“真实速度”汇报；该次响应没有条目样本时为 `null`，不要报成 0。
- **本轮** `turn.avgTokensPerSec` 只合并本轮已完成响应的时长（**不含**工具等待），`turn.responseSeconds` 是这些响应的时长之和，`turn.responses` 是响应次数；`turn.wallTokensPerSec` 用整轮墙钟 `turn.wallSeconds`（含工具调用等待），更接近“用户体感”。
- **会话** `session.avgTokensPerSec` 为全程响应时长加权平均（`session.responseSeconds` 为分母）；`session.wallTokensPerSec` 为各轮 `duration_ms` 合计下的吞吐。`session.truncatedStart` 为 `true` 表示只读了日志尾部：`session.id` 会从首行补读，但响应次数/平均速度只基于窗口内样本，不要当成完整会话统计。
- **推理占比** `session.reasoningShare` = 推理 token / 输出 token。比例高时，同样 tok/s 下用户看到的正文更少，这是“感觉慢”的最常见原因。
- **状态位**：`live.phase` 取 `generating`（正在生成）/ `tool`（模型在等工具结果）/ `stalled`（超过 15 分钟没有新样本）/ `idle`。新轮次刚开始、还没有新样本时，`live.tokensPerSec` 会继续展示上一次测得的速度，同时把 `turn` 指标归零。`live.generatingMs` 是本次生成已持续的毫秒数，可以说明“已经等了多久”。`live.stale` 为 `true` 表示最近样本超过 2 分钟，数字只能当历史参考。

## 输出格式

先给一句结论，再给数字，最后按需给细节。示例：

```
当前 74.9 tok/s（生成中，最近 3 次响应加权），本轮 69.3 tok/s，推理 token 占 82%。
```

如果用户追问原因，再展开：

```
- 最近一次响应：3,082 tokens（推理 2,257）/ 39.4s = 78.3 tok/s；纯生成 34.1s → 90.4 tok/s
- 最近 60 秒均值：71.2 tok/s（6 次响应）
- 本轮：23,173 tokens / 25 次响应，响应时长合计 334.3s = 69.3 tok/s；整轮墙钟 346s（含工具等待）= 67.0 tok/s
- 会话：输出 85,132，其中推理 70,113（82%）；响应时长合计 1136.6s = 74.9 tok/s；各轮墙钟合计 69.6 tok/s
```

注意“响应时长加权”与“整轮墙钟”是两个不同分母，汇报时要说清用的是哪个，不要只挑大的那个。

## 注意

- 不要编造数字。工具返回 `ok: false` 时，直接说明“还没有可用的会话数据”，并提示先发一条消息。
- 不要声称这是服务端指标；这是本地日志推算值，会滞后于真实流式速度，粒度就是“每次响应”。
- 工具调用期间没有样本，属于正常现象：模型没在生成，不是“速度掉了”。
- 默认按本次工具调用的 `_meta.threadId` 读取当前会话，**不会串到别的会话**；只有显式传 `session` 钉住时才查别的会话。若返回 `ok: false` / `reason: "session-not-found"`，说明当前会话还没有落盘日志，让用户先发一条消息，不要改读“最近活跃会话”。如果之前钉住过别的会话，传 `session: "auto"` 取消钉住。
- HUD 仅支持 Windows。其他平台请使用 Codex 会话右侧的速度面板。侧面板右上角有「打开悬浮窗 / 关闭悬浮窗」按钮，也可以直接用对话里的 `show_speed_hud` / `hide_speed_hud`。
- 速度面板是 app-only 的 thread entrypoint：用户从会话右侧的「速度面板」标签页打开，打开后会每秒自动刷新。模型没有打开侧面板的工具，不要调用 `show_speed_panel`，也不要声称“已经打开”；Codex 当前没有自动打开侧面板的 API。面板按 `threadId` 隔离，每个会话独立。
- 悬浮窗启动失败时，把错误原因如实转述，不要反复重试。