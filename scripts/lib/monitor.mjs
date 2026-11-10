// 会话监控器：跟随最新的（或指定的）rollout 文件，维护实时指标。

import fs from "node:fs";
import path from "node:path";
import { RolloutReader } from "./rollout.mjs";
import { computeMetrics } from "./metrics.mjs";
import {
  latestRollout,
  listRolloutFiles,
  findRolloutBySessionId,
  pluginDataDir,
  ensureDir,
} from "./paths.mjs";

const PIN_FILE = () => path.join(ensureDir(path.join(pluginDataDir(), "state")), "pinned-session.json");
const ACTIVE_FILE = () => path.join(ensureDir(path.join(pluginDataDir(), "state")), "active-session.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export class Monitor {
  constructor() {
    this.reader = null;
    this.file = null;
    /** 用户显式钉住的会话（get_reasoning_speed 的 session 参数） */
    this.pinnedFile = null;
    /** hook 报告的当前会话；每次提交提示都会更新，不覆盖显式钉住 */
    this.activeFile = null;
    /** hook 报告这条会话的时间，用来判断它是否已经过时 */
    this.activeAtMs = 0;
    this.lastSwitchCheck = 0;
    this.lastPoll = 0;
    /** 多会话 reader 缓存：侧面板可能同时轮询不同会话，不能共用一个 reader */
    this.readers = new Map();
    /** threadId -> rollout 路径的短缓存，避免新会话每秒全盘扫描 */
    this.sessionFiles = new Map();
    this._loadPinned();
  }

  _loadPinned() {
    const pin = readJson(PIN_FILE());
    if (pin && typeof pin.file === "string" && fs.existsSync(pin.file)) {
      this.pinnedFile = pin.file;
    }
    const active = readJson(ACTIVE_FILE());
    if (active && typeof active.transcriptPath === "string" && fs.existsSync(active.transcriptPath)) {
      this.activeFile = active.transcriptPath;
      this.activeAtMs = Number(active.atMs) || 0;
    }
  }

  /**
   * 由 hook 写入：当前活跃会话的 rollout 路径。
   * 只写 ACTIVE_FILE，不碰 PIN_FILE——否则用户显式钉住的会话会被下一次
   * 提交提示悄悄替换掉。
   */
  static recordActive(payload) {
    try {
      const transcriptPath =
        typeof payload.transcript_path === "string" && payload.transcript_path.trim()
          ? payload.transcript_path
          : null;
      // 没有 transcript_path 的 hook 事件不要覆盖已有的活跃会话记录
      if (!transcriptPath) return null;
      const active = ACTIVE_FILE();
      const info = {
        sessionId: payload.session_id ?? null,
        transcriptPath,
        cwd: payload.cwd ?? null,
        atMs: Date.now(),
      };
      fs.writeFileSync(active, JSON.stringify(info, null, 2));
      return info;
    } catch {
      return null;
    }
  }

  /** 让监控器跟随某个会话；不传则取消钉住、回到自动跟随。 */
  pin(fileOrSessionId = null) {
    if (!fileOrSessionId) {
      this.pinnedFile = null;
      try {
        fs.rmSync(PIN_FILE(), { force: true });
      } catch {
        /* ignore */
      }
      this._selectFile(true);
      return this.describe();
    }
    let file = fileOrSessionId;
    if (!fs.existsSync(file)) {
      // 当成 session id / 文件名片段来匹配
      const needle = String(fileOrSessionId);
      const hit = listRolloutFiles(200).find(
        (f) => f.name.includes(needle) || f.path.includes(needle)
      );
      if (!hit) throw new Error(`找不到匹配的会话: ${needle}`);
      file = hit.path;
    }
    this.pinnedFile = file;
    try {
      fs.writeFileSync(PIN_FILE(), JSON.stringify({ file }, null, 2));
    } catch {
      /* ignore */
    }
    this._open(file);
    return this.describe();
  }

  _selectFile(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSwitchCheck < 2000) return;
    this.lastSwitchCheck = now;

    // hook 会持续更新活跃会话；重读一次，别一直用启动时的那份
    const active = readJson(ACTIVE_FILE());
    if (active && typeof active.transcriptPath === "string" && fs.existsSync(active.transcriptPath)) {
      this.activeFile = active.transcriptPath;
      this.activeAtMs = Number(active.atMs) || 0;
    }

    if (this.pinnedFile) {
      if (!fs.existsSync(this.pinnedFile)) {
        // 被钉住的会话文件被删/归档了：内存里解除即可。
        // get_reasoning_speed 默认是只读查询，不要在这里顺手删除 PIN_FILE；
        // 需要清理状态请显式传 session=auto（pin(null)）。
        this.pinnedFile = null;
      } else {
        if (this.file !== this.pinnedFile) this._open(this.pinnedFile);
        return;
      }
    }

    const latest = latestRollout();
    // hook 报告的会话优先，但要能纠正：
    //   - hook 只在 SessionStart/UserPromptSubmit 触发，如果用户已经在别的会话里写了很久，
    //     那个会话的日志会比 hook 报告的时间新得多，此时应该跟随真正在被写入的文件。
    //   - 反过来，两个会话都“刚刚活跃”时（提交提示后日志还没落盘），以 hook 为准。
    let target = latest?.path ?? null;
    if (this.activeFile && fs.existsSync(this.activeFile)) {
      if (!latest || this.activeFile === latest.path) {
        target = this.activeFile;
      } else if (this.activeAtMs >= latest.mtimeMs - 60_000) {
        target = this.activeFile;
      } else {
        target = latest.path;
      }
    }
    if (target && target !== this.file) this._open(target);
  }

  _readerFor(file) {
    let entry = this.readers.get(file);
    if (!entry) {
      const reader = new RolloutReader(file);
      try {
        reader.prime();
      } catch {
        /* 读取失败时保留空状态 */
      }
      entry = { reader, usedAt: Date.now() };
      this.readers.set(file, entry);
    }
    entry.usedAt = Date.now();
    this._trimReaders();
    return entry.reader;
  }

  _trimReaders(max = 8) {
    if (this.readers.size <= max) return;
    const removable = [...this.readers.entries()]
      .filter(([file]) => file !== this.file)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.readers.size > max && removable.length) {
      const [file] = removable.shift();
      this.readers.delete(file);
    }
  }

  _open(file) {
    this.file = file;
    this.reader = this._readerFor(file);
    this.lastPoll = Date.now();
  }

  /**
   * threadId 来自 Codex 注入的 tools/call _meta，等同于会话日志的 session_id。
   * 找不到时明确返回 session-not-found，绝不回退到“最近活跃会话”，否则侧面板
   * 会读到另一个窗口的数据。
   */
  tickSession(sessionId) {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) {
      return {
        ok: false,
        reason: "session-not-found",
        threadId: null,
        hint: "没有拿到当前会话 id，无法定位会话日志。",
        generatedAt: Date.now(),
      };
    }
    const file = this._resolveSessionFile(id);
    if (!file) {
      return {
        ok: false,
        reason: "session-not-found",
        threadId: id,
        hint: `当前会话（${shortId(id)}）还没有本地日志。先在 Codex 里发一条消息，面板会自动开始。`,
        generatedAt: Date.now(),
      };
    }
    const reader = this._readerFor(file.path);
    try {
      reader.poll();
    } catch {
      /* 忽略瞬时 IO 错误 */
    }
    this.lastPoll = Date.now();
    return this._describe(reader, id, false);
  }

  _resolveSessionFile(sessionId) {
    const now = Date.now();
    const cached = this.sessionFiles.get(sessionId);
    if (cached && now - cached.atMs < (cached.path ? 5000 : 2000)) {
      if (cached.path && fs.existsSync(cached.path)) {
        return { path: cached.path, name: path.basename(cached.path) };
      }
      if (!cached.path) return null;
    }

    let file = null;
    const active = readJson(ACTIVE_FILE());
    if (
      active &&
      active.sessionId === sessionId &&
      typeof active.transcriptPath === "string" &&
      fs.existsSync(active.transcriptPath)
    ) {
      file = {
        path: active.transcriptPath,
        name: path.basename(active.transcriptPath),
      };
    } else {
      file = findRolloutBySessionId(sessionId);
    }

    this.sessionFiles.set(sessionId, { path: file?.path ?? null, atMs: now });
    if (this.sessionFiles.size > 32) {
      const oldest = [...this.sessionFiles.entries()].sort(
        (a, b) => a[1].atMs - b[1].atMs
      )[0];
      if (oldest) this.sessionFiles.delete(oldest[0]);
    }
    return file;
  }

  tick() {
    this._selectFile();
    if (this.reader) {
      try {
        this.reader.poll();
      } catch {
        /* 忽略瞬时 IO 错误 */
      }
    }
    this.lastPoll = Date.now();
    return this._describe(this.reader);
  }

  describe() {
    return this._describe(this.reader);
  }

  _describe(reader, threadId = "", pinned = Boolean(this.pinnedFile)) {
    if (!reader) {
      return {
        ok: false,
        reason: "no-session",
        hint: "还没有找到 Codex 会话日志。先在 Codex 里发一条消息。",
        generatedAt: Date.now(),
      };
    }
    const metrics = computeMetrics(reader.state);
    return {
      ok: true,
      ...metrics,
      threadId: threadId || metrics.session.id || null,
      scoped: Boolean(threadId),
      pinned,
    };
  }

  /** 最近若干个会话及其平均速度。 */
  listSessions(limit = 10) {
    const files = listRolloutFiles(limit * 3);
    const out = [];
    for (const f of files) {
      if (out.length >= limit) break;
      try {
        const reader = new RolloutReader(f.path, { fromStartBytes: 4 * 1024 * 1024 });
        reader.prime();
        const m = computeMetrics(reader.state);
        // 长会话的 session_meta 在读取窗口外时 id 可能为空；用文件名兜底，
        // 但空文件/坏文件（既没有 id、也没有任何用量）仍然跳过。
        const fallbackId = path.basename(f.path).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
        if (!m.session.id && !m.session.responses && !m.session.outputTokens) continue;
        out.push({
          file: f.path,
          sessionId: m.session.id ?? fallbackId,
          cwd: m.session.cwd,
          model: m.session.model,
          startedAtMs: m.session.startedAtMs,
          outputTokens: m.session.outputTokens,
          reasoningTokens: m.session.reasoningTokens,
          responses: m.session.responses,
          avgTokensPerSec: m.session.avgTokensPerSec,
          turns: m.session.turns,
        });
      } catch {
        /* 跳过坏文件 */
      }
    }
    return out;
  }
}

function shortId(id) {
  const text = String(id ?? "");
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

export const monitor = new Monitor();