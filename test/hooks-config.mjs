// 校验 hooks/hooks.json 是否符合桌面版 Codex 的插件 hook 约定。
// 用法：node test/hooks-config.mjs
//
// 这些字段名很容易被“顺手改成 CLI 的写法”而悄悄失效：
//   * 事件名必须是 PascalCase（SessionStart / UserPromptSubmit / Stop）
//   * 超时字段是 timeout（秒），不是 timeoutSec / timeout_sec
//   * 插件默认发现路径就是 hooks/hooks.json，manifest 里不该再声明 hooks
//   * command 必须能用 ${PLUGIN_ROOT} 指到真实存在的脚本

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const checks = [];
function check(name, cond, detail = "") {
  checks.push(Boolean(cond));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// 桌面版 hooks 文档里的事件名
const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionStart",
  "SessionEnd",
  "PreModelRequest",
  "PostModelRequest",
]);

const hooksFile = path.join(root, "hooks", "hooks.json");
let hooks = null;
try {
  hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
} catch (err) {
  check("hooks/hooks.json 可解析", false, err.message);
}

if (hooks) {
  check("hooks/hooks.json 可解析", true);
  check("顶层有 hooks 对象", hooks.hooks && typeof hooks.hooks === "object", Object.keys(hooks.hooks ?? {}).join(","));

  const events = Object.keys(hooks.hooks ?? {});
  const unknown = events.filter((e) => !KNOWN_EVENTS.has(e));
  check("事件名都是桌面版认识的名字", unknown.length === 0, unknown.join(",") || events.join(","));

  const wanted = ["SessionStart", "UserPromptSubmit", "Stop"];
  check("覆盖会话开始 / 提交提示 / 结束", wanted.every((e) => events.includes(e)), events.join(","));

  const handlers = events.flatMap((e) => hooks.hooks[e].flatMap((g) => g.hooks ?? []));
  check("至少有一个 handler", handlers.length > 0, String(handlers.length));
  check(
    "handler 都是 command 类型",
    handlers.every((h) => h.type === "command"),
    [...new Set(handlers.map((h) => h.type))].join(",")
  );

  const badTimeout = handlers.filter((h) => !("timeout" in h) && ("timeoutSec" in h || "timeout_sec" in h));
  check("超时字段用 timeout 而不是 timeoutSec", badTimeout.length === 0, `${badTimeout.length} 个写错`);

  const timeouts = handlers.map((h) => h.timeout).filter((t) => t !== undefined);
  check("timeout 是 1–600 秒的数字", timeouts.every((t) => Number.isFinite(t) && t >= 1 && t <= 600), timeouts.join(","));

  // 每个 command 里的 ${PLUGIN_ROOT}/... 都要指向真实文件
  const referenced = handlers
    .flatMap((h) => [h.command, h.commandWindows])
    .filter((c) => typeof c === "string")
    .map((c) => c.match(/\$\{PLUGIN_ROOT\}\/([^"'\s]+)/)?.[1])
    .filter(Boolean);
  const missing = referenced.filter((rel) => !fs.existsSync(path.join(root, rel)));
  check("${PLUGIN_ROOT} 指向的脚本都存在", referenced.length > 0 && missing.length === 0, missing.join(",") || referenced.join(","));

  check(
    "hook 命令在 Windows 上有同名覆盖",
    handlers.every((h) => typeof h.commandWindows === "string" && h.commandWindows.trim().length > 0)
  );

  check(
    "hook 是异步的，不会拖慢对话",
    handlers.every((h) => h.async === true)
  );
}

// manifest：portable 顶层不允许 hooks；extensions.com.openai 没定义 hooks 时才走默认发现
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
check("plugin.json 没有顶层 hooks 字段", !("hooks" in manifest), Object.keys(manifest).join(","));
const openaiExt = manifest.extensions?.["com.openai"] ?? {};
check("extensions.com.openai 未覆盖 hooks（走默认 hooks/hooks.json 发现）", !("hooks" in openaiExt), Object.keys(openaiExt).join(","));

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);