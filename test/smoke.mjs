// 本地自测：直接驱动 MCP server（stdio），并检查 HTTP 接口。
// 用法：node test/smoke.mjs [rollout 文件]

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "..", "scripts", "mcp-server.mjs");
const UI_URI = "ui://codex-speed/panel-v1.html";
const UI_MIME = "text/html;profile=mcp-app";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-smoke-"));
const codexHome = path.join(dataDir, "codex");

// 不依赖用户真实的 ~/.codex：写一个最小会话，保证在全新机器上也能跑。
const smokeDay = path.join(codexHome, "sessions", "2026", "11", "10");
fs.mkdirSync(smokeDay, { recursive: true });
const smokeT0 = Date.now();
const smokeIso = (ms) => new Date(ms).toISOString();
const smokeLines = [
  {
    timestamp: smokeIso(smokeT0),
    type: "session_meta",
    payload: {
      session_id: "smoke-session",
      cwd: dataDir,
      model: "smoke-model",
      cli_version: "test",
      originator: "smoke",
    },
  },
  {
    timestamp: smokeIso(smokeT0),
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1", started_at: Math.floor(smokeT0 / 1000) },
  },
  {
    timestamp: smokeIso(smokeT0 + 50),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
      started_at_ms: smokeT0 + 50,
      completed_at_ms: smokeT0 + 50,
    },
  },
  {
    timestamp: smokeIso(smokeT0 + 1050),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "Reasoning", id: "r1", summary_text: [{ type: "text", text: "think" }], raw_content: [] },
      started_at_ms: smokeT0 + 50,
      completed_at_ms: smokeT0 + 1050,
    },
  },
  {
    timestamp: smokeIso(smokeT0 + 1550),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "AgentMessage", id: "a1", content: [{ type: "text", text: "answer" }] },
      started_at_ms: smokeT0 + 1050,
      completed_at_ms: smokeT0 + 1550,
    },
  },
  {
    timestamp: smokeIso(smokeT0 + 2000),
    type: "token_usage_record",
    payload: {
      response_id: "resp-1",
      usage: { input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 20 },
      thread_token_usage: { input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 20 },
    },
  },
  {
    timestamp: smokeIso(smokeT0 + 2010),
    type: "event_msg",
    payload: {
      type: "task_complete",
      completed_at: Math.floor((smokeT0 + 2010) / 1000),
      duration_ms: 2010,
      time_to_first_token_ms: 500,
    },
  },
];
fs.writeFileSync(
  path.join(smokeDay, "rollout-2026-11-10T10-00-00-smoketest.jsonl"),
  smokeLines.map((line) => JSON.stringify(line)).join("\n") + "\n"
);

const proc = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PLUGIN_ROOT: path.resolve(__dirname, ".."),
    PLUGIN_DATA: dataDir,
    CODEX_HOME: codexHome,
  },
});
const rl = readline.createInterface({ input: proc.stdout });
const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");

const results = [];
let nextId = 1;
const pending = new Map();

proc.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 15000);
  });
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

const checks = [];
function check(name, cond, detail = "") {
  checks.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "smoke", title: "Smoke", version: "1.0.0" },
  });
  check("initialize", init.result?.serverInfo?.name === "codex-speed", init.result?.serverInfo?.name);
  check(
    "initialize 声明 resources 与 MCP Apps",
    Boolean(init.result?.capabilities?.resources) &&
      Boolean(init.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]),
    JSON.stringify(init.result?.capabilities)
  );

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const tools = await request("tools/list", {});
  const toolsList = tools.result?.tools ?? [];
  const names = toolsList.map((t) => t.name);
  check("tools/list 包含 6 个工具（含面板内部快照）", names.length === 6, names.join(","));
  const snapshotTool = toolsList.find((t) => t.name === "get_speed_snapshot");
  check(
    "get_speed_snapshot 是 app-only 只读工具",
    snapshotTool?.annotations?.readOnlyHint === true &&
      snapshotTool?._meta?.ui?.visibility?.includes("app"),
    JSON.stringify(snapshotTool?._meta?.ui)
  );
  const panelTool = toolsList.find((t) => t.name === "show_speed_panel");
  check(
    "show_speed_panel 绑定 MCP App 资源",
    panelTool?._meta?.ui?.resourceUri === UI_URI,
    String(panelTool?._meta?.ui?.resourceUri)
  );
  check(
    "show_speed_panel 是 app-only（模型调用不会内联渲染）",
    panelTool?._meta?.ui?.visibility?.includes("app") === true &&
      panelTool?._meta?.ui?.visibility?.includes("model") !== true,
    JSON.stringify(panelTool?._meta?.ui?.visibility)
  );
  check(
    "show_speed_panel 声明会话侧面板 entrypoint",
    Boolean(panelTool?._meta?.["openai/ui"]?.entrypoints?.some((e) => e.type === "thread")),
    JSON.stringify(panelTool?._meta?.["openai/ui"])
  );

  const speed = await request("tools/call", { name: "get_reasoning_speed", arguments: {} });
  const text = speed.result?.content?.[0]?.text ?? "";
  check("get_reasoning_speed 有返回", Boolean(text), text.split("\n")[0]);
  check("返回里含 tok/s", /tok\/s/.test(text));
  const structured = speed.result?.structuredContent;
  check("structuredContent.ok", structured?.ok === true, String(structured?.ok));
  check("PLUGIN_DATA 已隔离", structured?.hud?.dataDir === dataDir, structured?.hud?.dataDir);
  check("有会话 id", Boolean(structured?.session?.id), structured?.session?.id);
  check(
    "速度是有限数字",
    Number.isFinite(structured?.live?.tokensPerSec) && structured.live.tokensPerSec >= 0,
    String(structured?.live?.tokensPerSec)
  );
  check(
    "turnHistory 有本轮摘要",
    Array.isArray(structured?.turnHistory) &&
      structured.turnHistory.length === 1 &&
      structured.turnHistory[0].timeToFirstTokenMs === 500,
    JSON.stringify(structured?.turnHistory?.[0])
  );

  // 跨会话隔离：再造一个只含 session_meta 的会话，验证 threadId 精确取数。
  const otherSession = "smoke-other-session";
  const otherFile = path.join(
    smokeDay,
    `rollout-2026-11-10T09-00-00-${otherSession}.jsonl`
  );
  fs.writeFileSync(
    otherFile,
    JSON.stringify({
      timestamp: smokeIso(smokeT0 - 3600_000),
      type: "session_meta",
      payload: {
        session_id: otherSession,
        cwd: dataDir,
        model: "other-model",
        cli_version: "test",
      },
    }) + "\n"
  );
  const older = new Date(Date.now() - 3600_000);
  fs.utimesSync(otherFile, older, older);

  const scopedOther = await request("tools/call", {
    name: "get_speed_snapshot",
    arguments: {},
    _meta: { threadId: otherSession },
  });
  check(
    "get_speed_snapshot 按 threadId 隔离到另一个会话",
    scopedOther.result?.structuredContent?.ok === true &&
      scopedOther.result.structuredContent.session?.id === otherSession &&
      scopedOther.result.structuredContent.scoped === true,
    JSON.stringify(scopedOther.result?.structuredContent?.session)
  );

  const scopedMain = await request("tools/call", {
    name: "get_speed_snapshot",
    arguments: {},
    _meta: { threadId: "smoke-session" },
  });
  check(
    "get_speed_snapshot 按 threadId 找回文件名不匹配的当前会话",
    scopedMain.result?.structuredContent?.session?.id === "smoke-session",
    JSON.stringify(scopedMain.result?.structuredContent?.session)
  );

  const missingThread = await request("tools/call", {
    name: "get_speed_snapshot",
    arguments: {},
    _meta: { threadId: "missing-thread-id" },
  });
  check(
    "未知 threadId 返回 session-not-found，不串会话",
    missingThread.result?.structuredContent?.ok === false &&
      missingThread.result?.structuredContent?.reason === "session-not-found",
    JSON.stringify(missingThread.result?.structuredContent)
  );

  const modelScoped = await request("tools/call", {
    name: "get_reasoning_speed",
    arguments: {},
    _meta: { "x-codex-turn-metadata": { thread_id: otherSession, session_id: otherSession } },
  });
  check(
    "get_reasoning_speed 默认按 threadId 跟随当前会话",
    modelScoped.result?.structuredContent?.session?.id === otherSession,
    JSON.stringify(modelScoped.result?.structuredContent?.session)
  );

  const sessions = await request("tools/call", { name: "list_recent_sessions", arguments: { limit: 5 } });
  const list = sessions.result?.structuredContent?.sessions ?? [];
  check("list_recent_sessions 有结果", list.length > 0, `${list.length} 条`);

  // MCP Apps 侧面板：工具结果 + UI 资源
  const panelCall = await request("tools/call", {
    name: "show_speed_panel",
    arguments: {},
    _meta: { threadId: "smoke-session" },
  });
  check(
    "show_speed_panel 返回当前会话指标",
    panelCall.result?.structuredContent?.ok === true &&
      panelCall.result.structuredContent.session?.id === "smoke-session",
    JSON.stringify(panelCall.result?.structuredContent?.session)
  );
  check(
    "show_speed_panel 返回 UI 资源引用",
    panelCall.result?._meta?.ui?.resourceUri === UI_URI,
    String(panelCall.result?._meta?.ui?.resourceUri)
  );

  const resourceList = await request("resources/list", {});
  const uiResource = (resourceList.result?.resources ?? []).find((r) => r.uri === UI_URI);
  check("resources/list 暴露速度面板", uiResource?.mimeType === UI_MIME, String(uiResource?.mimeType));

  const resourceRead = await request("resources/read", { uri: UI_URI });
  const uiContent = resourceRead.result?.contents?.[0];
  const panelHtml = uiContent?.text ?? "";
  check(
    "resources/read 返回 MCP App HTML",
    uiContent?.mimeType === UI_MIME && panelHtml.includes("ui/initialize") && panelHtml.includes("get_speed_snapshot"),
    String(uiContent?.mimeType)
  );
  const panelScript = panelHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  let panelSyntax = true;
  try {
    new Function(panelScript);
  } catch {
    panelSyntax = false;
  }
  check("面板内联脚本语法正确", panelScript.length > 0 && panelSyntax, `${panelScript.length} chars`);

  // HTTP 接口
  const port = structured?.hud?.port;
  check("HTTP 端口存在", Number.isInteger(port), String(port));
  if (port) {
    const res = await fetch(`http://127.0.0.1:${port}/api/speed`);
    const body = await res.json();
    check("HTTP /api/speed 可用", body.ok === true, String(body.ok));
    check("HTTP /api/speed 未开放跨域读取", !res.headers.get("access-control-allow-origin"));
    const panel = await fetch(`http://127.0.0.1:${port}/panel`);
    const html = await panel.text();
    check("HTTP /panel 可用", html.includes("CODEX SPEED"));
  }

  const hide = await request("tools/call", { name: "hide_speed_hud", arguments: {} });
  check("hide_speed_hud 正常返回", Boolean(hide.result?.content?.[0]?.text));

  // PID 复用保护：把一个无关进程的 PID 写进 hud.pid，hide 必须拒绝 kill。
  async function checkHudGuard(command, args, label) {
    const helper = spawn(command, args, { stdio: "ignore", windowsHide: true });
    try {
      await new Promise((resolve, reject) => {
        helper.once("spawn", resolve);
        helper.once("error", reject);
      });
      fs.mkdirSync(path.join(dataDir, "run"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "run", "hud.pid"), String(helper.pid));
      const guarded = await request("tools/call", { name: "hide_speed_hud", arguments: {} });
      const g = guarded.result?.structuredContent;
      check(`${label}不会被误杀`, g?.stopped === false && g?.reason === "not-a-hud", JSON.stringify(g));
      let helperAlive = false;
      try {
        process.kill(helper.pid, 0);
        helperAlive = true;
      } catch {
        /* 已被杀 */
      }
      check(`${label}误杀保护后仍存活`, helperAlive);
    } finally {
      try {
        helper.kill();
      } catch {
        /* ignore */
      }
    }
  }

  await checkHudGuard(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "非 HUD 的 PID");
  if (process.platform === "win32") {
    // 进程名检查会放过 powershell；这里专门覆盖“PID 被别的 PowerShell 复用”的情况。
    await checkHudGuard(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
      "无关 PowerShell 进程"
    );

    // 正向路径：一个真正位于 scripts/hud.ps1 的无窗口 PowerShell 脚本应能被关闭。
    const fakeDir = path.join(dataDir, "fake", "scripts");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeHud = path.join(fakeDir, "hud.ps1");
    fs.writeFileSync(fakeHud, "Start-Sleep -Seconds 60\n");
    const fake = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fakeHud],
      { stdio: "ignore", windowsHide: true }
    );
    try {
      await new Promise((resolve, reject) => {
        fake.once("spawn", resolve);
        fake.once("error", reject);
      });
      fs.writeFileSync(path.join(dataDir, "run", "hud.pid"), String(fake.pid));
      const killed = await request("tools/call", { name: "hide_speed_hud", arguments: {} });
      const k = killed.result?.structuredContent;
      check("真正的 hud.ps1 可以被关闭", k?.stopped === true, JSON.stringify(k));
      let fakeAlive = true;
      try {
        process.kill(fake.pid, 0);
      } catch {
        fakeAlive = false;
      }
      check("关闭后目标进程已退出", !fakeAlive);
    } finally {
      try {
        fake.kill();
      } catch {
        /* ignore */
      }
    }
  }
} catch (err) {
  check("未抛异常", false, err.message);
} finally {
  proc.stdin.end();
  proc.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 上进程可能还没完全退出，留待系统清理 */
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);