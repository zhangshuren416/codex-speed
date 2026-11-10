// 指标口径回归测试。
//
// 两块内容：
//   1) 回放一个真实的历史 rollout，断言速度落在合理区间（不再出现 10^6 tok/s）
//   2) 合成一个“正在写入”的 rollout，验证增量读取、去重、生成中状态、锚点推进
//
// 用法：node test/metrics.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RolloutReader } from "../scripts/lib/rollout.mjs";
import { computeMetrics, MAX_GENERATION_MS } from "../scripts/lib/metrics.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/* ------------------------------------------------------------------ *
 * 1) 历史会话回放
 * ------------------------------------------------------------------ */
const HISTORICAL =
  process.env.CODEX_SPEED_TEST_ROLLOUT ??
  "/home/zhangshuren/.codex/sessions/2026/10/16/rollout-2026-10-16T10-49-22-01a1429d-39bc-7dd1-9859-a6cccaf7c6d3.jsonl";

if (fs.existsSync(HISTORICAL)) {
  const reader = new RolloutReader(HISTORICAL);
  reader.prime();
  const m = computeMetrics(reader.state);
  const rates = reader.state.samples.map((s) => s.tokensPerSec);
  const maxRate = Math.max(...rates);
  const minRate = Math.min(...rates);

  // 不绑定某一个开发机文件的精确 token 数；用“日志里最后一条累计用量”
  // 做通用一致性检查，这样换成任何真实 rollout 都能跑。
  function lastCumulativeOutput(file) {
    let last = null;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "token_usage_record") {
        const n = entry.payload?.thread_token_usage?.output_tokens;
        if (typeof n === "number") last = n;
      } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
        const n = entry.payload?.info?.total_token_usage?.output_tokens;
        if (typeof n === "number") last = n;
      }
    }
    return last;
  }
  const lastCum = lastCumulativeOutput(HISTORICAL);

  check("历史会话：至少采样到一次响应", rates.length > 0, `${rates.length} 条`);
  check("历史会话：最大速度不荒谬", maxRate < 400, `${maxRate.toFixed(1)} tok/s`);
  check("历史会话：最小速度为正", minRate > 0, `${minRate.toFixed(1)} tok/s`);
  check(
    "历史会话：会话均值在合理区间",
    m.session.avgTokensPerSec > 0 && m.session.avgTokensPerSec < 400,
    `${m.session.avgTokensPerSec} tok/s`
  );
  check(
    "历史会话：会话累计 token 与日志最后一条累计一致",
    lastCum === null || m.session.outputTokens === lastCum,
    `指标 ${m.session.outputTokens} / 日志 ${lastCum}`
  );
  check(
    "历史会话：推理占比在 0–1",
    m.session.reasoningShare >= 0 && m.session.reasoningShare <= 1,
    String(m.session.reasoningShare)
  );
  check(
    "历史会话：会话累计响应数覆盖当前轮样本",
    m.session.responses > 0 && m.session.responses >= rates.length,
    `样本 ${rates.length} / 会话 ${m.session.responses}`
  );
  check(
    "历史会话：五个速度口径都不为 NaN",
    [m.live.tokensPerSec, m.turn.avgTokensPerSec, m.session.avgTokensPerSec, m.session.wallTokensPerSec, m.turn.wallTokensPerSec].every(
      Number.isFinite
    )
  );
  check(
    "历史会话：状态字段类型正确",
    ["generating", "stalled", "active"].every((k) => typeof m.live[k] === "boolean"),
    `generating=${m.live.generating} stalled=${m.live.stalled} active=${m.live.active}`
  );
} else {
  console.log(`SKIP  历史会话回放（找不到 ${HISTORICAL}）`);
}

/* ------------------------------------------------------------------ *
 * 2) 合成“正在写入”的会话
 * ------------------------------------------------------------------ */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-test-"));
const liveFile = path.join(tmpDir, "rollout-live.jsonl");
fs.writeFileSync(liveFile, "");

const t0 = Date.now();
function iso(ms) {
  return new Date(ms).toISOString();
}
function line(obj) {
  fs.appendFileSync(liveFile, JSON.stringify(obj) + "\n");
}
function readAll(reader) {
  reader.poll();
  return computeMetrics(reader.state);
}

const reader = new RolloutReader(liveFile);
reader.prime();

let now = t0;
line({ timestamp: iso(now), type: "session_meta", payload: { session_id: "test-session", cwd: tmpDir, model: "test-model" } });
line({ timestamp: iso(now), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: Math.floor(now / 1000) } });
line({
  timestamp: iso(now + 50),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
    started_at_ms: now + 50,
    completed_at_ms: now + 50,
  },
});

// 生成过程中写入的零用量 token_count 不能推进锚点；否则第一次响应分母会变小，
// 下面的 500/6s 断言会变成约 125 tok/s。
line({
  timestamp: iso(now + 2000),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      last_token_usage: { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    },
  },
});

let m = readAll(reader);
check("合成会话：刚开始就是生成中", m.live.generating === true, String(m.live.generating));
check("合成会话：还没有速度样本", m.live.lastResponse === null);

// 第一次响应：思考 4s + 正文 1s，共 500 output tokens
line({
  timestamp: iso(now + 5000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "Reasoning", id: "r1", raw_content: [{ type: "text", text: "think" }], summary_text: [] },
    started_at_ms: now + 1000,
    completed_at_ms: now + 5000,
  },
});
line({
  timestamp: iso(now + 6000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "AgentMessage", id: "a1", content: [{ type: "text", text: "answer" }] },
    started_at_ms: now + 5000,
    completed_at_ms: now + 6000,
  },
});
line({
  timestamp: iso(now + 6000),
  type: "token_usage_record",
  payload: {
    thread_id: "test-session",
    response_id: "resp-1",
    usage: { input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 400 },
    thread_token_usage: { input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 400 },
  },
});
// 同一次响应随后又落一条 token_count —— 必须被去重
line({
  timestamp: iso(now + 6010),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 400 },
      last_token_usage: { input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 400 },
    },
  },
});

m = readAll(reader);
const first = reader.state.samples[0];
check("合成会话：只记录一次响应（去重）", reader.state.samples.length === 1, `${reader.state.samples.length} 条`);
check("合成会话：速度 = 500/6s 约 83", first && Math.abs(first.tokensPerSec - 83.3) < 2, String(first?.tokensPerSec));
check("合成会话：纯生成速度 = 500/5s 约 100", first && Math.abs(first.genTokensPerSec - 100) < 2, String(first?.genTokensPerSec));
check("合成会话：输出 token 记录正确", m.live.lastResponse?.outputTokens === 500, String(m.live.lastResponse?.outputTokens));
check("合成会话：响应结束后不再生成中", m.live.generating === false, String(m.live.generating));
check("合成会话：会话均值等于首个样本", Math.abs(m.session.avgTokensPerSec - 83.3) < 2, String(m.session.avgTokensPerSec));

// 工具调用：耗时 20s，期间不应产生速度样本
line({
  timestamp: iso(now + 8000),
  type: "response_item",
  payload: { type: "function_call", id: "f1", name: "shell", arguments: "{}" },
});
line({
  timestamp: iso(now + 26000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "CommandExecution", id: "c1" },
    started_at_ms: now + 6000,
    completed_at_ms: now + 26000,
  },
});
line({
  timestamp: iso(now + 26000),
  type: "response_item",
  payload: { type: "function_call_output", id: "o1", call_id: "c1", output: "done" },
});
m = readAll(reader);
check("合成会话：工具执行期间不产生样本", reader.state.samples.length === 1, `${reader.state.samples.length} 条`);
check("合成会话：工具结束后重新进入生成中", m.live.generating === true, String(m.live.generating));

// 第二次响应：只思考 3s，200 tokens。分母应从那一次工具输出算起，而不是整段 20s。
line({
  timestamp: iso(now + 29000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "Reasoning", id: "r2", raw_content: [{ type: "text", text: "think2" }], summary_text: [] },
    started_at_ms: now + 26000,
    completed_at_ms: now + 29000,
  },
});
line({
  timestamp: iso(now + 29000),
  type: "token_usage_record",
  payload: {
    response_id: "resp-2",
    usage: { input_tokens: 120, output_tokens: 200, reasoning_output_tokens: 200 },
    thread_token_usage: { input_tokens: 220, output_tokens: 700, reasoning_output_tokens: 600 },
  },
});
m = readAll(reader);
const second = reader.state.samples[1];
check("合成会话：第二次响应被记录", reader.state.samples.length === 2, `${reader.state.samples.length} 条`);
check(
  "合成会话：工具耗时不计入分母（200/3s 约 67）",
  second && Math.abs(second.tokensPerSec - 66.7) < 3,
  String(second?.tokensPerSec)
);
check("合成会话：会话均值是加权平均", Math.abs(m.session.avgTokensPerSec - 700 / 9) < 2, String(m.session.avgTokensPerSec));

// 第三次响应：custom_tool_call（Codex 桌面版 shell/freeform 工具的实际类型）
// + 20s 工具执行 + custom_tool_call_output。工具时间不能算进下一次响应。
line({
  timestamp: iso(now + 31000),
  type: "response_item",
  payload: { type: "custom_tool_call", id: "ct1", name: "shell", arguments: "{}" },
});
line({
  timestamp: iso(now + 51000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "CommandExecution", id: "c2" },
    started_at_ms: now + 31000,
    completed_at_ms: now + 51000,
  },
});
line({
  timestamp: iso(now + 51000),
  type: "response_item",
  payload: { type: "custom_tool_call_output", id: "cto1", call_id: "ct1", output: "done" },
});
m = readAll(reader);
check(
  "合成会话：custom_tool_call_output 后回到生成中",
  m.live.generating === true && m.live.waitingTool === false,
  `generating=${m.live.generating} waitingTool=${m.live.waitingTool}`
);
line({
  timestamp: iso(now + 53000),
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "Reasoning", id: "r3", raw_content: [{ type: "text", text: "think3" }], summary_text: [] },
    started_at_ms: now + 51000,
    completed_at_ms: now + 53000,
  },
});
line({
  timestamp: iso(now + 53000),
  type: "token_usage_record",
  payload: {
    response_id: "resp-3",
    usage: { input_tokens: 20, output_tokens: 300, reasoning_output_tokens: 0 },
    thread_token_usage: { input_tokens: 240, output_tokens: 1000, reasoning_output_tokens: 600 },
  },
});
m = readAll(reader);
const third = reader.state.samples[2];
check(
  "合成会话：custom tool 的 20s 不计入分母（300/2s = 150）",
  third && Math.abs(third.wallSecs - 2) < 0.2 && Math.abs(third.tokensPerSec - 150) < 5,
  `wall=${third?.wallSecs} rate=${third?.tokensPerSec}`
);

// 第四次响应只有 token 用量、没有任何 Reasoning/AgentMessage 条目：
// genSeconds 应为 0，genTokensPerSec 应为 null（不是 0.0）。
line({
  timestamp: iso(now + 55000),
  type: "token_usage_record",
  payload: {
    response_id: "resp-4",
    usage: { input_tokens: 20, output_tokens: 100, reasoning_output_tokens: 0 },
    thread_token_usage: { input_tokens: 260, output_tokens: 1100, reasoning_output_tokens: 600 },
  },
});
m = readAll(reader);
check(
  "合成会话：没有条目耗时样本时 genTokensPerSec 为 null",
  m.live.lastResponse?.genSeconds === 0 && m.live.lastResponse?.genTokensPerSec === null,
  `genSeconds=${m.live.lastResponse?.genSeconds} genTokensPerSec=${m.live.lastResponse?.genTokensPerSec}`
);

check(
  "合成会话：turn 摘要字段完整",
  Number.isFinite(m.turn.reasoningTokens) &&
    m.turn.reasoningShare >= 0 &&
    m.turn.reasoningShare <= 1 &&
    (m.turn.avgMsPerToken === null || m.turn.avgMsPerToken > 0),
  `reasoning=${m.turn.reasoningTokens} share=${m.turn.reasoningShare} ms/token=${m.turn.avgMsPerToken}`
);

// 分母异常小（1000 tokens / 0.1s = 10000 tok/s）时丢弃样本，避免污染曲线。
line({
  timestamp: iso(now + 55100),
  type: "token_usage_record",
  payload: {
    response_id: "resp-fast",
    usage: { input_tokens: 20, output_tokens: 1000, reasoning_output_tokens: 0 },
    thread_token_usage: { input_tokens: 280, output_tokens: 2100, reasoning_output_tokens: 600 },
  },
});
m = readAll(reader);
check(
  "合成会话：超过 400 tok/s 的异常样本被丢弃",
  reader.state.samples.length === 4 && m.live.lastResponse?.outputTokens === 100,
  `samples=${reader.state.samples.length} lastOut=${m.live.lastResponse?.outputTokens}`
);

// 长文件：session_meta 在 256B 尾部窗口之外，仍要能从头部补读
const longFile = path.join(tmpDir, "rollout-long.jsonl");
const longMeta =
  JSON.stringify({
    timestamp: iso(t0),
    type: "session_meta",
    payload: { session_id: "long-session", cwd: tmpDir, model: "long-model" },
  }) + "\n";
const longTail =
  JSON.stringify({
    timestamp: iso(t0 + 1000),
    type: "token_usage_record",
    payload: {
      usage: { input_tokens: 1, output_tokens: 10 },
      thread_token_usage: { input_tokens: 1, output_tokens: 10 },
    },
  }) + "\n";
fs.writeFileSync(longFile, longMeta + "x".repeat(4096) + "\n" + longTail);
const longReader = new RolloutReader(longFile, { fromStartBytes: 256 });
longReader.prime();
const lm = computeMetrics(longReader.state);
check("长文件：尾部读取仍恢复 session_meta", lm.session.id === "long-session", String(lm.session.id));
check("长文件：尾部用量仍被读到", lm.session.outputTokens === 10, String(lm.session.outputTokens));

// UTF-8 字符被拆到两次 poll 之间时，StringDecoder 应把字节拼回去，
// 不能变成两个 U+FFFD 写坏正文。
const utf8File = path.join(tmpDir, "rollout-utf8.jsonl");
const utf8Line =
  JSON.stringify({
    timestamp: iso(t0),
    type: "event_msg",
    payload: { type: "agent_message", message: "你" },
  }) + "\n";
const utf8Buf = Buffer.from(utf8Line, "utf8");
const charIndex = utf8Buf.indexOf(Buffer.from("你", "utf8"));
fs.writeFileSync(utf8File, utf8Buf.subarray(0, charIndex + 1));
const utf8Reader = new RolloutReader(utf8File);
utf8Reader.prime();
fs.appendFileSync(utf8File, utf8Buf.subarray(charIndex + 1));
utf8Reader.poll();
check(
  "UTF-8 跨块字符不损坏",
  utf8Reader.state.items.agentMessage.chars === 1,
  `chars=${utf8Reader.state.items.agentMessage.chars}`
);

// 长静默：不应该因为“很久没有事件”而误判成仍在生成，也不该掉成 0
m = computeMetrics(reader.state, now + 29000 + 30 * 60_000);
check("合成会话：长时间静默后不再是生成中", m.live.generating === false, String(m.live.generating));
check("合成会话：静默后仍保留上次测得速度", m.live.tokensPerSec > 0, String(m.live.tokensPerSec));

// 新轮次：samples 不清空，live 继续展示上次测得速度；本轮指标必须归零。
line({
  timestamp: iso(now + 56000),
  type: "event_msg",
  payload: { type: "task_started", turn_id: "turn-2", started_at: Math.floor((now + 56000) / 1000) },
});
m = readAll(reader);
check(
  "合成会话：新轮次保留上次速度但本轮指标归零",
  m.live.generating === true &&
    m.live.lastResponse !== null &&
    m.live.tokensPerSec > 0 &&
    m.turn.responses === 0 &&
    reader.state.samples.length >= 4,
  `live=${m.live.tokensPerSec} last=${m.live.lastResponse?.tokensPerSec} turn=${m.turn.responses} samples=${reader.state.samples.length}`
);

// 超过 MAX_GENERATION_MS 仍没有新样本：应标记 stalled，而不是“等待首字”。
m = computeMetrics(reader.state, now + 56000 + MAX_GENERATION_MS + 1000);
check(
  "合成会话：超过 15 分钟标记 stalled",
  m.live.generating === true && m.live.active === false && m.live.stalled === true && m.live.phase === "stalled",
  `generating=${m.live.generating} active=${m.live.active} stalled=${m.live.stalled} phase=${m.live.phase}`
);

fs.rmSync(tmpDir, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 3) 阶段机：逐行回放真实日志，检查 generating / tool 的切换是否合理
 * ------------------------------------------------------------------ */
if (fs.existsSync(HISTORICAL)) {
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-replay-"));
  const replayFile = path.join(tmpDir2, "rollout-replay.jsonl");
  fs.writeFileSync(replayFile, "");
  const replay = new RolloutReader(replayFile);
  replay.prime();

  const lines = fs.readFileSync(HISTORICAL, "utf8").split("\n").filter((l) => l.trim());
  let toolSeen = 0;
  let afterToolOutput = 0;
  let phaseErrors = 0;
  let rateErrors = 0;
  let responses = 0;

  for (const line of lines.slice(0, 400)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const before = replay.state.samples.length;
    fs.appendFileSync(replayFile, line + "\n");
    replay.poll();
    const st = replay.state;
    const p = entry.payload ?? {};
    const ts = Date.parse(entry.timestamp);

    if (entry.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      toolSeen += 1;
      if (st.generating) phaseErrors += 1; // 已发出工具调用，不该还标成生成中
    }
    if (entry.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      afterToolOutput += 1;
      if (!st.generating) phaseErrors += 1; // 工具结果回来，应重新进入生成中
    }
    const isUsage =
      entry.type === "token_usage_record" || (entry.type === "event_msg" && p.type === "token_count");
    if (isUsage) {
      responses += 1;
      // 只有“真的新增了样本”时才应离开生成中；重复上报的 token_count 可能发生在
      // 工具结果已回来之后，那时本来就该重新算作生成中
      const added = st.samples.length > before;
      if (added && st.generating) phaseErrors += 1;
    }
    // 每一步的速度都必须是有限值且没有荒谬值
    const m = computeMetrics(st, ts);
    const rate = m.live.tokensPerSec;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) {
      rateErrors += 1;
      if (rateErrors <= 3) console.log(`      异常读数 ${rate} @ ${entry.timestamp} ${entry.type}`);
    }
  }

  check("阶段机：识别到工具调用", toolSeen > 5, `${toolSeen} 次`);
  check("阶段机：工具结果后回到生成中", afterToolOutput > 5, `${afterToolOutput} 次`);
  check("阶段机：没有阶段错乱", phaseErrors === 0, `${phaseErrors} 次异常`);
  check("阶段机：全程速度都是有限值且不荒谬", rateErrors === 0, `${responses} 次用量事件，${rateErrors} 次异常`);
  fs.rmSync(tmpDir2, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);