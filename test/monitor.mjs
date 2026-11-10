// 会话跟随 / 钉住 / hook 报告 的回归测试。
// 用法：node test/monitor.mjs
//
// 这些路径以前出过问题：hook 每次提交提示都覆盖“钉住”的会话，导致
// get_reasoning_speed 的 session 参数看起来生效、下一次提问又被换走。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-mon-"));
const codexHome = path.join(root, "codex");
const sessDir = path.join(codexHome, "sessions", "2026", "11", "09");
fs.mkdirSync(sessDir, { recursive: true });

process.env.CODEX_HOME = codexHome;
process.env.PLUGIN_DATA = path.join(root, "data");

const { Monitor } = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "lib", "monitor.mjs")).href);

const checks = [];
function check(name, cond, detail = "") {
  checks.push(Boolean(cond));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const metaLine = (id) =>
  JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id, session_id: id, cwd: "/x", cli_version: "1" },
  }) + "\n";

const oldFile = path.join(sessDir, "rollout-2026-11-09T10-00-00-aaaaaaaa.jsonl");
const newFile = path.join(sessDir, "rollout-2026-11-09T11-00-00-bbbbbbbb.jsonl");
fs.writeFileSync(oldFile, metaLine("aaaaaaaa"));
fs.writeFileSync(newFile, metaLine("bbbbbbbb"));
const hourAgo = new Date(Date.now() - 3600_000);
fs.utimesSync(oldFile, hourAgo, hourAgo);

const activeFile = () => path.join(root, "data", "state", "active-session.json");
const pinFile = path.join(root, "data", "state", "pinned-session.json");
function reportActive(file, id, atMs = Date.now()) {
  fs.mkdirSync(path.dirname(activeFile()), { recursive: true });
  fs.writeFileSync(activeFile(), JSON.stringify({ sessionId: id, transcriptPath: file, cwd: "/x", atMs }));
}

const base = () => path.basename(m?.file ?? "?");

// 1. 没有任何活跃会话信息时跟随最新文件
let m = new Monitor();
m.tick();
check("自动跟随最新的 rollout", m.file === newFile, base());

// 1a. threadId 精确跟随：即使目标不是最新文件，也不能串到最新会话
const scopedOld = m.tickSession("aaaaaaaa");
check(
  "tickSession 按会话 id 精确定位",
  scopedOld.ok === true && scopedOld.session?.id === "aaaaaaaa" && scopedOld.scoped === true,
  JSON.stringify(scopedOld.session)
);
const scopedNew = m.tickSession("bbbbbbbb");
check(
  "tickSession 可同时保留多个会话 reader",
  scopedNew.ok === true &&
    scopedNew.session?.id === "bbbbbbbb" &&
    m.readers.has(oldFile) &&
    m.readers.has(newFile),
  `${m.readers.size} 个 reader`
);
const missing = m.tickSession("no-such-session");
check(
  "未知 threadId 返回 session-not-found 而不是串会话",
  missing.ok === false && missing.reason === "session-not-found",
  JSON.stringify(missing)
);

// 1b. 文件名里没有 session id 时，回读首行 session_meta 兜底
const headOnlyFile = path.join(sessDir, "rollout-2026-11-09T13-00-00-weirdname.jsonl");
fs.writeFileSync(headOnlyFile, metaLine("cccccccc"));
const older = new Date(Date.now() - 2 * 3600_000);
fs.utimesSync(headOnlyFile, older, older);
const headOnly = m.tickSession("cccccccc");
check(
  "tickSession 回读 session_meta 兜底",
  headOnly.ok === true && headOnly.session?.id === "cccccccc",
  JSON.stringify(headOnly.session)
);

// 2. hook 报告了另一个“刚刚活跃”的会话时以 hook 为准
reportActive(oldFile, "aaaaaaaa");
m = new Monitor();
m.tick();
check("hook 报告的活跃会话优先", m.file === oldFile, base());

// 2b. 没有 transcript_path 的 hook 不能把已有活跃会话覆盖成 null
const activeBefore = fs.readFileSync(activeFile(), "utf8");
const recorded = Monitor.recordActive({ session_id: "missing-transcript" });
check(
  "无 transcript_path 的 hook 不覆盖活跃会话",
  recorded === null && fs.readFileSync(activeFile(), "utf8") === activeBefore
);

// 3. 显式钉住
m.pin("bbbbbbbb");
check("pin 生效", m.file === newFile, base());

// 4. 之后再来一次提示（hook 报告旧会话）：不能覆盖显式 pin
reportActive(oldFile, "aaaaaaaa");
m.lastSwitchCheck = 0;
m.tick();
check("hook 不覆盖显式 pin", m.file === newFile, base());

// 5. 模拟 server 重启：pin 要能持久化
m = new Monitor();
m.tick();
check("pin 跨进程持久化", m.file === newFile, base());

// 6. hook 报告已经过期（很久以前）时，应跟随正在被写入的最新文件
reportActive(oldFile, "aaaaaaaa", Date.now() - 5 * 60_000);
m = new Monitor();
m.tick();
check("陈旧的 hook 报告不压住最新文件", m.file === newFile, base());

// 7. 取消 pin 后回到自动跟随
m.pin(null);
check("取消 pin 后恢复跟随", m.file === newFile, base());
check("取消 pin 会删除状态文件", !fs.existsSync(pinFile));

// 8. 钉住的会话文件被删除后自动解除
m.pin("bbbbbbbb");
fs.rmSync(newFile);
m.lastSwitchCheck = 0;
m.tick();
check("钉住文件消失后自动解除", m.pinnedFile === null, String(m.pinnedFile));

// 9. 找不到的会话 id 要报错，而不是静默跟随别的会话
let threw = false;
try {
  m.pin("no-such-session");
} catch {
  threw = true;
}
check("无效的 session 参数会报错", threw);

// 10. 多次 tick 不应重复 prime 或改坏状态
fs.writeFileSync(newFile, metaLine("bbbbbbbb"));
m.pin("bbbbbbbb");
m.tick();
m.tick();
check("重复 tick 保持同一会话", m.file === newFile, base());

// 11. 大于 listSessions 尾部窗口（4MB）的会话不能因为 session_meta 在窗口外就消失
const longFile = path.join(sessDir, "rollout-2026-11-09T12-00-00-longsession.jsonl");
fs.writeFileSync(longFile, metaLine("longsession") + "x".repeat(5 * 1024 * 1024) + "\n");
const listed = m.listSessions(20);
check(
  "大于 4MB 的会话仍出现在列表",
  listed.some((s) => s.sessionId === "longsession"),
  listed.map((s) => s.sessionId).join(",")
);

fs.rmSync(root, { recursive: true, force: true });
const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);