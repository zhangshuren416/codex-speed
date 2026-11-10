// Codex Speed —— hook 入口
//
// 作用：把当前会话的 rollout 路径记下来，让 MCP server / HUD 立刻跟随正确的会话，
// 避免在“同时开了好几个会话”或“刚新建会话还没写 token”时跟错文件。
//
// 该脚本必须永远快速退出且永不失败，否则会拖慢或干扰 Codex 会话。

import { Monitor } from "./lib/monitor.mjs";

let input = "";

function done(code = 0) {
  try {
    process.exitCode = code;
  } catch {
    /* ignore */
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 1_000_000) input = input.slice(0, 1_000_000);
});

process.stdin.on("end", () => {
  try {
    if (input.trim()) {
      const payload = JSON.parse(input);
      Monitor.recordActive(payload);
    }
  } catch {
    /* 绝不因为解析失败影响会话 */
  }
  done(0);
});

// 兜底：如果 Codex 不给 stdin，也不要挂住会话
const guard = setTimeout(() => {
  done(0);
  process.exit(0);
}, 2000);
guard.unref?.();

process.stdin.on("error", () => done(0));