#!/usr/bin/env node
// Codex Speed —— MCP stdio server + 本地 HUD 数据接口 + HUD 进程管理
//
// 设计要点：
//   * 只用 Node 内置模块，无需 npm install。
//   * 同一个进程既服务 MCP（stdin/stdout），又在 127.0.0.1 上开一个只读 HTTP 接口给 HUD 拉数据。
//   * HUD 是一个 PowerShell + WinForms 的置顶小窗（Windows 自带，无需额外运行时）。
//     Node 负责数据与进程生命周期，PowerShell 只负责画窗口。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitor } from "./lib/monitor.mjs";
import { pluginDataDir, ensureDir } from "./lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT
  ? path.resolve(process.env.PLUGIN_ROOT)
  : path.resolve(__dirname, "..");

// 版本号只在 plugin.json 里维护；打包脚本命名归档也用同一个字段，避免两处漂移。
const PLUGIN_VERSION = readPluginVersion();

function readPluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "plugin.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" && parsed.version
      ? parsed.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const DATA_DIR = ensureDir(pluginDataDir());
const RUN_DIR = ensureDir(path.join(DATA_DIR, "run"));
const PORT_FILE = path.join(RUN_DIR, "hud-port.json");
const HUD_PID_FILE = path.join(RUN_DIR, "hud.pid");
const LOG_FILE = path.join(RUN_DIR, "server.log");
const HUD_LOG_FILE = path.join(RUN_DIR, "hud.log");

// MCP Apps：会话侧面板的 UI 资源（Codex Desktop 通过 thread entrypoint 打开）
const UI_URI = "ui://codex-speed/panel-v1.html";
const UI_MIME = "text/html;profile=mcp-app";
const UI_PANEL_FILE = path.join(PLUGIN_ROOT, "scripts", "ui", "panel.html");
const UI_RESOURCE = {
  uri: UI_URI,
  name: "codex_speed_panel",
  description: "Codex Speed 实时吞吐面板（本轮 / 会话）",
  mimeType: UI_MIME,
  _meta: {
    ui: { prefersBorder: true },
    "openai/ui": {
      availableDisplayModes: ["inline", "fullscreen"],
      preferredDisplayMode: "fullscreen",
    },
  },
};

const IS_WINDOWS = process.platform === "win32";
const HUD_PORT_PREFERENCE = [8787, 8788, 8789, 0];

// 采样间隔：轻量（只是 stat + 读取新增字节）
const TICK_MS = 1000;

let tickTimer = null;
let hudPort = null;
let httpServer = null;
let httpReady = null;
let hudPidCache = { pid: null, alive: false, atMs: 0 };

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
}

function readUiPanelHtml() {
  try {
    return fs.readFileSync(UI_PANEL_FILE, "utf8");
  } catch (err) {
    return (
      "<!doctype html><meta charset=\"utf-8\">" +
      "<body style=\"font:13px sans-serif;padding:16px;background:#171a1f;color:#e8eaed\">" +
      "<strong>Codex Speed 面板资源缺失</strong><p>" +
      String(err.message || err) +
      "</p><p>请重新安装插件。</p></body>"
    );
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 接口（给 HUD 用）
 * ------------------------------------------------------------------ */
function startHttp() {
  if (httpServer) return Promise.resolve(hudPort);

  const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // 只允许本机访问
    const remote = req.socket.remoteAddress ?? "";
    if (!/^(127\.|::1|::ffff:127\.)/.test(remote)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (url.pathname === "/api/speed") {
      const body = JSON.stringify(snapshot());
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end("not found");
  };

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = HUD_PORT_PREFERENCE[Math.min(attempt, HUD_PORT_PREFERENCE.length - 1)];
      httpServer = http.createServer(handler);
      httpServer.once("error", (err) => {
        httpServer?.close();
        httpServer = null;
        if (err.code === "EADDRINUSE" && attempt < HUD_PORT_PREFERENCE.length - 1) {
          attempt += 1;
          tryListen();
          return;
        }
        log("http error", err.message);
        reject(err);
      });
      httpServer.listen(port, "127.0.0.1", () => {
        hudPort = httpServer.address().port;
        try {
          fs.writeFileSync(PORT_FILE, JSON.stringify({ port: hudPort, pid: process.pid, atMs: Date.now() }));
        } catch {
          /* ignore */
        }
        log("http listening on", hudPort);
        resolve(hudPort);
      });
    };
    tryListen();
  });
}

function stopHttp() {
  if (!httpServer) return;
  try {
    httpServer.close();
  } catch {
    /* ignore */
  }
  httpServer = null;
  // 可能有更新的 MCP server 实例已经改写了端口文件；只有它仍指向自己时才删除
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf8");
    const info = JSON.parse(raw);
    if (info.pid === process.pid) fs.rmSync(PORT_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 快照（MCP 与 HTTP 共用）
 * ------------------------------------------------------------------ */
/**
 * Codex 在每次 MCP tools/call 的 _meta 里注入当前线程：
 *   - 顶层 threadId（模型调用与面板手动调用都有）
 *   - x-codex-turn-metadata.thread_id / session_id（模型生成时）
 * 面板必须据此精确取数，不能退回“最近活跃会话”。
 */
function threadIdFromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const direct = meta.threadId ?? meta.thread_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const turn = meta["x-codex-turn-metadata"];
  if (turn && typeof turn === "object") {
    for (const key of ["thread_id", "session_id"]) {
      const value = turn[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function withHud(m) {
  return { ok: m.ok, ...m, hud: hudStatus() };
}

function snapshot(threadId = "") {
  return withHud(threadId ? monitor.tickSession(threadId) : monitor.tick());
}

function hudStatus() {
  const running = hudIsAlive();
  return {
    platform: process.platform,
    supported: IS_WINDOWS || Boolean(process.env.CODEX_SPEED_HUD_ALLOW_NONWINDOWS),
    running,
    // 刚启动时 HUD 可能还没来得及写 pid 文件，退回子进程 PID
    pid: running ? readHudPid() : null,
    port: hudPort,
    shell: resolvePowerShell(),
    script: hudScriptPath(),
    // 数据目录由 Codex 的 PLUGIN_DATA 决定，不同安装方式路径不同，直接回给调用方
    dataDir: DATA_DIR,
    logFile: HUD_LOG_FILE,
  };
}

function readHudPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(HUD_PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * PID 会被系统复用：HUD 被强杀后留下的 pid 文件可能指向一个无关进程，
 * 那样 show_speed_hud 会误以为窗口已经开着，实际什么也不会弹出来。
 * Windows 上用 tasklist 核对进程名，代价是一次几十毫秒的子进程，调用频率很低。
 */
function windowsProcessName(pid) {
  if (!IS_WINDOWS) return null;
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const out = (r.stdout ?? "").trim();
    if (!out) return null; // 查不到
    if (/no tasks|没有运行/i.test(out)) return null;
    const m = out.match(/^"([^"]+)"/);
    return (m ? m[1] : out).toLowerCase();
  } catch {
    return null;
  }
}

function pidLooksLikeHud(pid) {
  if (!IS_WINDOWS) return true;
  const name = windowsProcessName(pid);
  if (!name) return true; // 查不到就按存活处理，避免误判后重复开窗口
  return /powershell|pwsh/i.test(name);
}

function windowsProcessInfo(pid) {
  try {
    const ps = resolvePowerShell();
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; ` +
      `if ($p) { [pscustomobject]@{ name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`;
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").replace(/^\uFEFF/, "").trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * 关闭 HUD 前做深度校验：不能只信 PID 文件。Windows 会复用 PID，一个
 * 无关的 powershell.exe 也可能通过进程名检查，taskkill /F 会直接杀掉它。
 *
 * 返回：
 *   { ok: true }                      确认是本插件的 hud.ps1，可以结束
 *   { ok: false, verified: true }     确认不是 HUD（或已经不在运行）
 *   { ok: false, verified: false }    无法确认，宁可拒绝 kill
 */
function verifyHudPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, verified: true, reason: "invalid-pid" };
  }
  if (pid === process.pid) {
    return { ok: false, verified: true, reason: "self-pid" };
  }
  if (!processAlive(pid)) {
    return { ok: false, verified: true, reason: "not-running" };
  }

  if (!IS_WINDOWS) {
    let cmdline = null;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      /* macOS 等没有 /proc，退回 ps */
      try {
        const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 3000,
        });
        if (r.status === 0) cmdline = r.stdout ?? "";
      } catch {
        /* ignore */
      }
    }
    if (cmdline === null) return { ok: false, verified: false, reason: "cannot-verify" };
    return /scripts[\\/]hud\.ps1/i.test(cmdline)
      ? { ok: true, verified: true }
      : { ok: false, verified: true, reason: "not-a-hud" };
  }

  const name = windowsProcessName(pid);
  if (!name) return { ok: false, verified: false, reason: "cannot-verify" };
  if (!/powershell|pwsh/.test(name)) {
    return { ok: false, verified: true, reason: "not-a-hud" };
  }

  const info = windowsProcessInfo(pid);
  if (!info || typeof info.commandLine !== "string") {
    return { ok: false, verified: false, reason: "cannot-verify" };
  }
  return /scripts[\\/]hud\.ps1/i.test(info.commandLine)
    ? { ok: true, verified: true }
    : { ok: false, verified: true, reason: "not-a-hud" };
}

/** 只有 PID 文件仍然指向这个 pid 时才删除，避免误删新 HUD 的记录。 */
function clearHudPidFile(pid) {
  try {
    if (readHudPid() === pid) fs.rmSync(HUD_PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/** HUD 可能由上一个 MCP server 实例启动，所以以 PID 文件为准，而不是本地句柄。 */
function hudIsAlive() {
  const pid = readHudPid();
  if (!pid) return false;

  // hudStatus() 每秒被 HUD 轮询调用一次；tasklist 有成本，缓存一小段时间
  const now = Date.now();
  if (hudPidCache.pid === pid && now - hudPidCache.atMs < 5000) return hudPidCache.alive;

  const alive = processAlive(pid) && pidLooksLikeHud(pid);
  hudPidCache = { pid, alive, atMs: now };
  if (!alive) {
    try {
      fs.rmSync(HUD_PID_FILE, { force: true });
    } catch {
      /* ignore */
    }
  }
  return alive;
}

/* ------------------------------------------------------------------ *
 * HUD 启动 / 停止
 * ------------------------------------------------------------------ */
function hudScriptPath() {
  return path.join(PLUGIN_ROOT, "scripts", "hud.ps1");
}

// 在 Windows 上优先用系统自带的 Windows PowerShell 5.1：它保证有 GDI+/WinForms。
// pwsh 7 在 Windows 上虽然能用 WinForms，但新版 System.Drawing.Common 默认只允许
// Windows，且行为与 5.1 有细微差别，非必要不用。
function resolvePowerShell() {
  if (process.env.CODEX_SPEED_PWSH) return process.env.CODEX_SPEED_PWSH;
  if (!IS_WINDOWS) return "pwsh";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const bundled = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(bundled) ? bundled : "powershell.exe";
}

async function launchHud({ opacity, alwaysOnTop = true, scale = 1 } = {}) {
  // 确保 HTTP 已经拿到端口，避免 server 还在 8788、HUD 却先连 8787 的竞态。
  await ensureMonitoring();
  if (hudIsAlive()) {
    const pid = readHudPid();
    // PID 文件可能来自上一个 MCP server 实例；先深校验，避免 PID 复用后
    // 一个无关的 powershell 一直挡住新窗口。
    if (pid) {
      const check = verifyHudPid(pid);
      if (check.verified && !check.ok) {
        clearHudPidFile(pid);
      } else {
        return hudStatus();
      }
    } else {
      return hudStatus();
    }
  }
  if (!IS_WINDOWS && !process.env.CODEX_SPEED_HUD_ALLOW_NONWINDOWS) {
    throw new Error(
      "HUD 需要 Windows 的 PowerShell/WinForms。当前平台是 " +
        process.platform +
        "，请使用 Codex 会话右侧的速度面板，或设置 CODEX_SPEED_HUD_ALLOW_NONWINDOWS=1 强制尝试。"
    );
  }

  const script = hudScriptPath();
  if (!fs.existsSync(script)) throw new Error(`找不到 HUD 脚本: ${script}`);

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Port",
    String(hudPort ?? 8787),
    "-PidFile",
    HUD_PID_FILE,
    "-PortFile",
    PORT_FILE,
  ];
  if (opacity != null) args.push("-Opacity", String(opacity));
  if (scale) args.push("-Scale", String(scale));
  if (alwaysOnTop) args.push("-AlwaysOnTop");

  // PowerShell 的错误（WinForms 初始化失败、脚本语法错等）必须留下来，
  // 否则用户只看到“窗口没出现”，无从排查。
  let logFd = "ignore";
  try {
    logFd = fs.openSync(HUD_LOG_FILE, "a");
    fs.writeSync(logFd, `\n===== ${new Date().toISOString()} spawn =====\n`);
  } catch {
    logFd = "ignore";
  }

  const cmd = resolvePowerShell();
  // 不能直接 spawn(..., { detached: true })：在 Windows 上这会让 powershell.exe
  // 立即以 code 0 退出，HUD 窗口根本不会出现。改用 Start-Process：它创建的进程
  // 脱离 MCP server 独立存活，-NoNewWindow 让它继承 hidden wrapper 的控制台，
  // 所以不会有黑框，WinForms 窗口仍然正常显示。
  const quoteArg = (value) => {
    const text = String(value);
    // 只给含空格/引号的参数加引号；像 -AlwaysOnTop 这样的开关一旦被引号包住，
    // PowerShell 会当成普通字符串，开关就失效（HUD 窗口不会置顶）。
    return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  };
  const quoteSingle = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const innerArgs = args.map(quoteArg).join(" ");
  const launchScript = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    `  Start-Process -FilePath ${quoteSingle(cmd)} -ArgumentList ${quoteSingle(innerArgs)} -NoNewWindow | Out-Null`,
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
  const encoded = Buffer.from(launchScript, "utf16le").toString("base64");

  const wrapper = spawn(cmd, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    stdio: ["ignore", "ignore", logFd],
    // wrapper 的控制台必须隐藏；HUD 继承这个隐藏控制台，WinForms 窗口不受影响
    windowsHide: true,
    cwd: PLUGIN_ROOT,
  });
  // spawn 失败（找不到 powershell.exe / pwsh）是异步 error 事件；
  // 不监听会让整个 MCP server 直接崩掉
  wrapper.on("error", () => {
    /* 由下面的 await 统一处理 */
  });
  if (typeof logFd === "number") {
    try {
      fs.closeSync(logFd);
    } catch {
      /* 子进程已复制句柄 */
    }
  }
  log("hud spawn wrapper", cmd, args.join(" "));

  // 只等 wrapper 完成 Start-Process；真正的 HUD 进程在后面用 PID 文件确认。
  const wrapperExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 2500);
    timer.unref?.();
    wrapper.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    wrapper.once("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err });
    });
  });

  if (wrapperExit.error || wrapperExit.timeout || wrapperExit.code !== 0) {
    const status = hudStatus();
    return {
      ...status,
      running: false,
      error: wrapperExit.error
        ? `无法启动 ${cmd}：${wrapperExit.error.code ?? ""} ${wrapperExit.error.message}`.trim()
        : wrapperExit.timeout
          ? "启动 HUD 的 PowerShell 超时"
          : `启动 HUD 失败（code=${wrapperExit.code}, signal=${wrapperExit.signal}）`,
      logFile: HUD_LOG_FILE,
      logTail: readLogTail(12),
    };
  }

  // HUD 启动后在 forms 显示前写 PID 文件；等它出现并确认进程还活着。
  const deadline = Date.now() + 3000;
  let hudPid = null;
  while (Date.now() < deadline) {
    const pid = readHudPid();
    if (pid && processAlive(pid)) {
      hudPid = pid;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!hudPid) {
    const status = hudStatus();
    return {
      ...status,
      running: false,
      error: "HUD 未能在预期时间内启动",
      logFile: HUD_LOG_FILE,
      logTail: readLogTail(12),
    };
  }
  return { ...hudStatus(), running: true, logFile: HUD_LOG_FILE };
}

function readLogTail(lines = 15) {
  try {
    const text = fs.readFileSync(HUD_LOG_FILE, "utf8");
    return text.trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function stopHud({ force = false } = {}) {
  const pid = readHudPid();
  if (!pid) {
    return { stopped: false, reason: "not-running" };
  }

  // 关键：先确认这个 PID 真的是本插件的 hud.ps1。PID 复用后直接
  // taskkill /T /F 可能杀掉一个完全无关的进程树。
  const check = verifyHudPid(pid);
  if (!check.ok) {
    if (check.verified) clearHudPidFile(pid);
    if (check.reason === "not-running") {
      return { stopped: false, reason: "not-running" };
    }
    if (check.reason === "not-a-hud" || check.reason === "self-pid" || check.reason === "invalid-pid") {
      return { stopped: false, pid, reason: "not-a-hud" };
    }
    if (check.reason === "cannot-verify") {
      return { stopped: false, pid, reason: "cannot-verify" };
    }
    return { stopped: false, pid, reason: check.reason ?? "invalid-pid" };
  }

  let error = null;
  try {
    if (IS_WINDOWS) {
      // PowerShell 的 WinForms 消息循环需要在同一会话里优雅退出；先 taskkill 整棵树
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      if (r.error) error = r.error.message;
      else if (r.status !== 0) {
        error = ((r.stderr || r.stdout) ?? "").trim() || `taskkill exit ${r.status}`;
      }
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch (err) {
    error = err.message;
  }

  // taskkill /F 返回后进程可能还在退出中；确认真的退出再删 PID 文件，
  // 否则会误报“已关闭”，下一次 show_speed_hud 又开出一个重复窗口。
  for (let i = 0; i < 20 && processAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processAlive(pid)) {
    log("stop hud failed", String(pid), error ?? "process still alive");
    return { stopped: false, pid, reason: "still-running", error: error ?? "进程仍在运行" };
  }

  clearHudPidFile(pid);
  return { stopped: true, pid };
}

/* ------------------------------------------------------------------ *
 * MCP 工具定义
 * ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: "get_reasoning_speed",
    title: "查询当前推理速度",
    description:
      "读取本地 Codex 会话日志，返回当前会话的实时输出速度（tok/s，含思考与正文）、本轮平均速度、会话平均速度、推理 token 占比等指标。默认按本次调用的 threadId 读取当前会话，不会串到别的窗口；可选地用 session 参数钉住某个会话，传 auto 取消钉住。",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "可选。会话 id 或 rollout 文件名片段；传 auto 取消钉住、回到自动跟随；省略则按本次调用的 threadId 读取当前会话（宿主不提供 threadId 时才退回最近活跃会话）。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "get_speed_snapshot",
    title: "读取速度快照",
    description:
      "仅供 Codex Speed 侧面板轮询使用的只读快照。按调用方注入的 threadId 读取当前会话，不改变会话跟随/钉住状态，也不会跟随其他会话。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "list_recent_sessions",
    title: "列出最近会话的速度",
    description: "列出最近若干个 Codex 会话及其输出 token 数、思考 token 数与平均 tok/s，可用于横向比较。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, description: "返回条数，默认 10。" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "show_speed_panel",
    title: "速度面板",
    description:
      "Codex Speed 会话侧面板入口。只对 App / 用户入口可见，模型不应调用；用户从会话右侧的「速度面板」标签页打开后，面板会每秒自动刷新，并始终显示当前会话。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: {
      // visibility 包含 app 才会注册 thread entrypoint；不包含 model，
      // 这样模型不会调用它，也就不会在对话里内联渲染。
      ui: { resourceUri: UI_URI, visibility: ["app"] },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  },
  {
    name: "show_speed_hud",
    title: "打开速度悬浮窗",
    description:
      "在 Windows 上打开一个置顶的小窗，实时显示 tok/s、本轮 token 和最近速度曲线。可设置透明度与缩放。",
    inputSchema: {
      type: "object",
      properties: {
        opacity: { type: "number", minimum: 0.2, maximum: 1, description: "窗口不透明度，默认 0.92。" },
        scale: { type: "number", minimum: 0.6, maximum: 2, description: "界面缩放，默认 1。" },
        alwaysOnTop: { type: "boolean", description: "是否置顶，默认 true。" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    // 侧面板的「打开悬浮窗」按钮也调用这个工具。
    _meta: { ui: { visibility: ["model", "app"] } },
  },
  {
    name: "hide_speed_hud",
    title: "关闭速度悬浮窗",
    description: "关闭由本插件打开的速度悬浮窗。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    // 侧面板的「关闭悬浮窗」按钮也调用这个工具。
    _meta: { ui: { visibility: ["model", "app"] } },
  },
];

async function callTool(name, args = {}, meta = null) {
  const threadId = threadIdFromMeta(meta);
  switch (name) {
    case "get_reasoning_speed": {
      const requested = typeof args.session === "string" ? args.session.trim() : "";
      if (requested) {
        if (/^(auto|unpin|clear)$/i.test(requested)) monitor.pin(null);
        else monitor.pin(requested);
      }
      // 显式钉住优先；否则跟随本次调用的 threadId；只有宿主不提供 threadId
      // 时才退回旧的“最近活跃会话”逻辑。
      let m;
      if (monitor.pinnedFile) {
        m = withHud(monitor.tick());
        // 被钉住的文件被删/归档：tick() 会解除 pin，此时回到当前会话
        if (!monitor.pinnedFile && threadId) m = withHud(monitor.tickSession(threadId));
      } else {
        m = withHud(threadId ? monitor.tickSession(threadId) : monitor.tick());
      }
      return { structuredContent: m, content: [{ type: "text", text: renderSpeed(m) }] };
    }
    case "get_speed_snapshot": {
      const m = snapshot(threadId);
      return {
        structuredContent: m,
        content: [{ type: "text", text: renderSpeed(m) }],
      };
    }
    case "list_recent_sessions": {
      const sessions = monitor.listSessions(Number(args.limit) || 10);
      return {
        structuredContent: { sessions },
        content: [{ type: "text", text: renderSessions(sessions) }],
      };
    }
    case "show_speed_panel": {
      const m = snapshot(threadId);
      return {
        structuredContent: m,
        content: [{ type: "text", text: renderSpeed(m) }],
        _meta: { ui: { resourceUri: UI_URI } },
      };
    }
    case "show_speed_hud": {
      const status = await launchHud({
        opacity: args.opacity,
        scale: args.scale,
        alwaysOnTop: args.alwaysOnTop !== false,
      });
      let text;
      if (status.running) {
        text = `已打开速度悬浮窗（PID ${status.pid}），数据端口 127.0.0.1:${status.port}。`;
      } else {
        text =
          `悬浮窗未能启动：${status.error ?? "未知原因"}。` +
          (status.logTail ? `\n最近的 HUD 日志：\n${status.logTail}` : "") +
          `\n完整日志：${status.logFile ?? "(无)"}\n可以改用 Codex 会话右侧的速度面板。`;
      }
      return { structuredContent: status, content: [{ type: "text", text }] };
    }
    case "hide_speed_hud": {
      const r = await stopHud();
      let text;
      if (r.stopped) {
        text = "已关闭速度悬浮窗。";
      } else if (r.reason === "not-running") {
        text = "悬浮窗当前没有在运行。";
      } else if (r.reason === "not-a-hud") {
        text =
          "PID 文件指向的不是 Codex Speed 悬浮窗（可能已退出且 PID 被复用），" +
          "已清理过期记录，没有结束任何进程。";
      } else if (r.reason === "cannot-verify") {
        text =
          "无法确认 PID 对应的进程是不是本插件的悬浮窗，已拒绝结束它。" +
          "请手动关闭窗口，或删除运行目录里的 hud.pid。";
      } else {
        text = `未能关闭悬浮窗：${r.error ?? r.reason ?? "未知原因"}`;
      }
      return { structuredContent: r, content: [{ type: "text", text }] };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * 渲染成给模型看的文字
 * ------------------------------------------------------------------ */
function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function renderSpeed(m) {
  if (!m.ok) return `暂时拿不到速度数据：${m.hint ?? m.reason ?? "未知原因"}`;
  const { live, turn, session, reasoning, answer } = m;
  const waitingTool = live.waitingTool;
  const lines = [];
  const state = waitingTool
    ? "工具执行中"
    : live.stalled
      ? "长时间无样本"
      : live.active
        ? "生成中"
        : live.generating
          ? "等待首个 token"
          : "空闲";
  lines.push(
    `当前速度：${fmt(live.tokensPerSec)} tok/s（${state}${
      live.lastResponse ? (live.stale ? "；最近一次样本已过期，仅供参考" : "；按最近测得的样本估计") : "；还没有样本"
    }${waitingTool ? "，工具执行期间不产生 token" : ""}）`
  );
  if (live.lastResponse) {
    const lr = live.lastResponse;
    const gen =
      lr.genTokensPerSec == null
        ? "纯生成 无条目耗时样本"
        : `纯生成 ${fmt(lr.genSeconds, 2)}s → ${fmt(lr.genTokensPerSec)} tok/s`;
    lines.push(
      `最近一次响应：输出 ${lr.outputTokens} tokens（推理 ${lr.reasoningTokens}）/ ${fmt(
        lr.seconds,
        2
      )}s = ${fmt(lr.tokensPerSec)} tok/s；${gen}（${fmt(lr.ageMs / 1000, 1)}s 前）`
    );
  }
  if (live.recentAvg60s) lines.push(`最近 60 秒均值：${fmt(live.recentAvg60s)} tok/s（${live.samplesInWindow} 次响应）`);
  lines.push(
    `本轮：输出 ${turn.outputTokens} tokens / ${turn.responses} 次响应；响应时长合计 ${fmt(
      turn.responseSeconds,
      1
    )}s → ${fmt(turn.avgTokensPerSec)} tok/s；整轮墙钟 ${fmt(turn.wallSeconds, 1)}s（含工具等待）→ ${fmt(
      turn.wallTokensPerSec
    )} tok/s；首 token ${
      turn.timeToFirstTokenMs == null ? "—" : `${fmt(turn.timeToFirstTokenMs / 1000, 2)}s`
    }；平均 ${turn.avgMsPerToken == null ? "—" : `${fmt(turn.avgMsPerToken, 1)} ms/token`}`
  );
  lines.push(
    `会话：输出 ${session.outputTokens}，其中推理 ${session.reasoningTokens}（占 ${fmt(
      session.reasoningShare * 100,
      0
    )}%）；响应时长合计 ${fmt(session.responseSeconds, 1)}s → ${fmt(
      session.avgTokensPerSec
    )} tok/s；各轮墙钟合计 ${fmt(session.wallTokensPerSec)} tok/s${
      session.truncatedStart ? "（只读日志尾部，均值/响应数只覆盖尾部样本）" : ""
    }`
  );
  lines.push(`模型：${session.model ?? "—"}${session.effort ? ` / ${session.effort}` : ""}`);
  if (m.scoped && m.threadId) lines.push(`会话跟随：当前会话（threadId ${m.threadId}）`);
  if (m.pinned) lines.push("会话跟随：已钉住（传 session=auto 可恢复自动跟随）");
  if (reasoning.tokens) {
    lines.push(
      `思考：${reasoning.items} 个条目，${reasoning.tokens} tokens，约 ${fmt(
        reasoning.tokensPerSec
      )} tok/s（按条目生成耗时）`
    );
  }
  if (answer.items) {
    lines.push(`正文：${answer.items} 个条目，${answer.chars} 字符，生成耗时 ${fmt(answer.seconds, 1)}s（此耗时只覆盖正文条目本身）`);
  }
  lines.push("口径：每次模型响应落盘一条用量记录，速度=该响应输出 token/（提示就绪→响应结束），粒度即“每次响应”，非逐 token 实时。");
  lines.push(`数据源：${session.file}`);
  return lines.join("\n");
}

function renderSessions(sessions) {
  if (!sessions.length) return "没有找到任何会话日志。";
  const rows = sessions.map((s, i) => {
    const when = s.startedAtMs ? new Date(s.startedAtMs).toLocaleString() : "—";
    const rate = s.avgTokensPerSec > 0 ? `${fmt(s.avgTokensPerSec)} tok/s` : "无速度样本";
    return `${i + 1}. ${rate} | 输出 ${s.outputTokens}（推理 ${s.reasoningTokens}）| ${
      s.responses
    } 次响应 | ${s.model ?? "—"} | ${when} | ${s.sessionId ?? ""}`;
  });
  return ["最近会话（按响应时长加权的平均速度；无回复的会话不计速度）：", ...rows].join("\n");
}

/* ------------------------------------------------------------------ *
 * MCP 协议（JSON-RPC over stdio，一行一条）
 * ------------------------------------------------------------------ */
function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function reply(id, result) {
  send({ id, result });
}

function replyError(id, code, message) {
  send({ id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    await ensureMonitoring();
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: {
        tools: {},
        resources: {},
        extensions: { "io.modelcontextprotocol/ui": {} },
      },
      serverInfo: { name: "codex-speed", version: PLUGIN_VERSION },
      instructions:
        "这是 Codex 本地速度计。回答“多快/速度/为什么慢”时调用 get_reasoning_speed；它默认按当前会话的 threadId 读取，不会串到别的会话。用户想在 Codex 会话右侧看实时面板时，请让用户点击会话侧边的「速度面板」标签页——该入口是 app-only，模型没有打开侧面板的工具，也不要在对话里声称已经打开。Windows 置顶小窗用 show_speed_hud。所有数据来自本地会话日志；传 session 参数会把该会话钉住，传 session=auto 可恢复自动跟随。",
    });
  }
  if (method === "notifications/initialized") {
    return;
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const result = await callTool(name, args, params?._meta ?? null);
      return reply(id, result);
    } catch (err) {
      return reply(id, {
        content: [{ type: "text", text: `调用失败：${err.message}` }],
        isError: true,
      });
    }
  }
  if (method === "resources/list") {
    return reply(id, { resources: [UI_RESOURCE] });
  }
  if (method === "resources/read") {
    const uri = params?.uri;
    if (uri !== UI_URI) {
      return replyError(id, -32002, `Resource not found: ${uri ?? "(missing uri)"}`);
    }
    return reply(id, {
      contents: [
        {
          uri: UI_URI,
          mimeType: UI_MIME,
          text: readUiPanelHtml(),
          _meta: {
            ui: { prefersBorder: true },
            "openai/ui": {
              availableDisplayModes: ["inline", "fullscreen"],
              preferredDisplayMode: "fullscreen",
            },
          },
        },
      ],
    });
  }
  if (method === "resources/templates/list") return reply(id, { resourceTemplates: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });

  if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
}

function ensureMonitoring() {
  if (tickTimer) return httpReady ?? Promise.resolve(hudPort);
  tickTimer = setInterval(() => {
    try {
      monitor.tick();
    } catch (err) {
      log("tick error", err.message);
    }
  }, TICK_MS);
  tickTimer.unref?.();
  httpReady = startHttp().catch((err) => {
    log("http failed", err.message);
    return null;
  });
  return httpReady;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handleMessage(msg)).catch((err) => {
      log("handler error", err.message);
      if (msg.id !== undefined) replyError(msg.id, -32603, err.message);
    });
  }
});

function shutdown() {
  // 注意：HUD 故意不在这里关闭。MCP server 是“每个会话一个”的，
  // 关掉某个会话就把用户的悬浮窗一起杀掉会很突兀。HUD 的生命周期由
  // hide_speed_hud 或用户自己关窗口决定；进程死了靠 PID 文件兜底清理。
  stopHttp();
  if (tickTimer) clearInterval(tickTimer);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", () => {
  // stdio 关闭：MCP 客户端退出。HUD 保留（见 shutdown 的说明）。
  shutdown();
});

log("codex-speed mcp server started", `pid=${process.pid}`, `root=${PLUGIN_ROOT}`, `data=${DATA_DIR}`);
ensureMonitoring();
