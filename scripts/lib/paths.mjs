// 路径解析：跨平台定位 Codex 主目录与会话日志目录。
// 只依赖 Node 内置模块，零 npm 依赖。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Codex 主目录。
 * Windows 上通常是 %USERPROFILE%\.codex；允许用 CODEX_HOME 覆盖（Codex 自身也读这个变量）。
 */
export function codexHome() {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".codex");
}

export function sessionsDir() {
  return path.join(codexHome(), "sessions");
}

export function archivedSessionsDir() {
  return path.join(codexHome(), "archived_sessions");
}

/** 插件可写数据目录（由 Codex 注入）；没有时退回临时目录下的固定位置。 */
export function pluginDataDir() {
  const fromEnv = process.env.PLUGIN_DATA;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.tmpdir(), "codex-speed");
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

/**
 * 列出当前存在的 rollout 文件，按文件名（内含本地时间戳）从新到旧。
 * 文件名形如 rollout-2026-11-09T19-35-50-<uuid>.jsonl，可直接按字典序排序。
 */
export function listRolloutFiles(limit = 40) {
  const roots = [sessionsDir(), archivedSessionsDir()];
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, out, 0);
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out.slice(0, limit);
}

function walk(dir, out, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      out.push({ name: entry.name, path: full });
    }
  }
}

/**
 * 按 Codex 的会话 / 线程 id 找对应的 rollout 文件。
 *
 * Codex 桌面版会在每次 MCP tools/call 的 _meta.threadId 里带上当前对话 id，
 * 它与会话日志的文件名、首行 session_meta 里的 session_id 是同一个值。
 * 面板必须按这个 id 精确取数，不能退回“最近活跃文件”，否则多开窗口时会串会话。
 */
export function findRolloutBySessionId(sessionId, limit = 200) {
  const needle = typeof sessionId === "string" ? sessionId.trim().toLowerCase() : "";
  if (!needle) return null;
  const files = listRolloutFiles(limit);

  // 最常见：rollout-...-<session id>.jsonl
  const suffix = `-${needle}.jsonl`;
  const exact = files.find((file) => file.name.toLowerCase().endsWith(suffix));
  if (exact) return exact;

  // 文件名里带 id 的变体；太短的 id 不做模糊匹配，避免误中别的会话
  if (needle.length >= 8) {
    const loose = files.find((file) => file.name.toLowerCase().includes(needle));
    if (loose) return loose;
  }

  // 文件名被改过 / 旧版命名：回读首行 session_meta 兜底
  for (const file of files.slice(0, 60)) {
    const id = readSessionIdFromHead(file.path);
    if (id && id.toLowerCase() === needle) return file;
  }
  return null;
}

function readSessionIdFromHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const first = buf
      .subarray(0, n)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split("\n", 1)[0]
      .trim();
    if (!first) return null;
    const entry = JSON.parse(first);
    if (entry?.type !== "session_meta") return null;
    const payload = entry.payload ?? {};
    const id = payload.session_id ?? payload.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 取最近被修改的 rollout（即“当前正在使用的会话”）。 */
export function latestRollout(maxProbe = 8) {
  const files = listRolloutFiles(maxProbe);
  let best = null;
  for (const file of files) {
    try {
      const st = fs.statSync(file.path);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { ...file, mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch {
      /* 文件可能正被删除 */
    }
  }
  return best;
}