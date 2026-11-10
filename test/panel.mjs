// MCP Apps 侧面板的桥接冒烟：用假 DOM + 假 host 跑一遍 panel.html 的内联脚本。
//
// 不依赖 Codex Desktop，验证：
//   ui/initialize → ui/notifications/initialized → tools/call(get_reasoning_speed)
//   以及指标是否写进 DOM。

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "scripts", "ui", "panel.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const messages = [];
const listeners = new Map();
let onMessage = null;
const elements = new Map();

function makeElement(id) {
  return {
    id,
    textContent: "",
    className: "",
    title: "",
    disabled: false,
    style: { color: "", display: "", setProperty() {} },
    dataset: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(name, handler) {
      listeners.set(`${id}:${name}`, handler);
    },
    clientWidth: 360,
    clientHeight: 64,
    width: 0,
    height: 0,
    getContext() {
      return {
        setTransform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        closePath() {},
        fillText() {},
        set strokeStyle(value) {},
        set fillStyle(value) {},
        set lineWidth(value) {},
        set lineJoin(value) {},
        set font(value) {},
      };
    },
  };
}

for (const id of [
  "phase",
  "dot",
  "hudToggle",
  "tps",
  "liveRate",
  "ttft",
  "mspt",
  "turnTokens",
  "spark",
  "session",
  "history",
  "source",
  "stale",
]) {
  elements.set(id, makeElement(id));
}

const document = {
  documentElement: { style: { setProperty() {} }, dataset: {}, scrollWidth: 360, scrollHeight: 300 },
  body: {},
  head: { appendChild() {} },
  getElementById: (id) => elements.get(id) ?? makeElement(id),
  createElement: () => {
    const child = { className: "", textContent: "", children: [], appendChild(item) { this.children.push(item); } };
    return child;
  },
};

const window = {
  parent: { postMessage: (message) => messages.push(message) },
  addEventListener: (name, handler) => {
    if (name === "message") onMessage = handler;
  },
  devicePixelRatio: 1,
};

const metrics = {
  ok: true,
  live: {
    active: false,
    stalled: false,
    generating: false,
    waitingTool: false,
    tokensPerSec: 52,
    stale: false,
    lastResponse: {
      tokensPerSec: 52,
      outputTokens: 100,
      seconds: 1.95,
      genTokensPerSec: 66.7,
      ageMs: 2000,
      atMs: Date.now(),
    },
  },
  turn: {
    outputTokens: 100,
    responses: 1,
    avgTokensPerSec: 51.3,
    wallTokensPerSec: 49.8,
    wallSeconds: 2.01,
    timeToFirstTokenMs: 500,
    avgMsPerToken: 19.5,
    reasoningTokens: 20,
    reasoningShare: 0.2,
  },
  session: {
    id: "s1",
    outputTokens: 100,
    reasoningTokens: 20,
    reasoningShare: 0.2,
    avgTokensPerSec: 51.3,
    wallTokensPerSec: 49.8,
    truncatedStart: false,
    model: "test",
    effort: "high",
  },
  hud: { supported: true, running: false },
  turnHistory: [
    { id: "t0", endedAtMs: Date.now() - 60_000, outputTokens: 80, avgTokensPerSec: 40, timeToFirstTokenMs: 700 },
    { id: "t1", endedAtMs: Date.now(), outputTokens: 100, avgTokensPerSec: 51.3, timeToFirstTokenMs: 500 },
  ],
};

function respond(id, result) {
  setTimeout(() => onMessage?.({ data: { jsonrpc: "2.0", id, result } }), 0);
}
window.parent.postMessage = (message) => {
  messages.push(message);
  if (message.method === "ui/initialize") {
    respond(message.id, {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "test-host", version: "1.0.0" },
      hostCapabilities: { serverTools: {} },
      hostContext: {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
      },
    });
  } else if (message.method === "ui/request-display-mode") {
    respond(message.id, { mode: "fullscreen" });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "show_speed_hud") {
      metrics.hud.running = true;
      respond(message.id, { structuredContent: { supported: true, running: true } });
    } else if (name === "hide_speed_hud") {
      metrics.hud.running = false;
      respond(message.id, { structuredContent: { stopped: true, pid: 123 } });
    } else {
      respond(message.id, {
        content: [{ type: "text", text: "ok" }],
        structuredContent: metrics,
      });
    }
  }
};

class ResizeObserver {
  observe() {}
  disconnect() {}
}

const context = {
  window,
  document,
  getComputedStyle: () => ({
    getPropertyValue: (name) =>
      ({
        "--accent": "#10a37f",
        "--border": "#2a3038",
        "--dim2": "#717b89",
        "--sans": "sans-serif",
      })[name] ?? "",
  }),
  ResizeObserver,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

if (!script) {
  check("panel.html 包含内联脚本", false);
} else {
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const methods = messages.map((message) => message.method).filter(Boolean);
  const toolCalls = messages.filter((message) => message.method === "tools/call");

  check("panel: 发送 ui/initialize", methods.includes("ui/initialize"));
  check("panel: 完成 initialized 握手", methods.includes("ui/notifications/initialized"));
  check(
    "panel: inline 挂载时主动请求 fullscreen（进入侧面板）",
    methods.includes("ui/request-display-mode") &&
      messages.some(
        (message) =>
          message.method === "ui/request-display-mode" && message.params?.mode === "fullscreen"
      )
  );
  check(
    "panel: 通过 MCP Apps 调用 get_speed_snapshot",
    toolCalls.some((message) => message.params?.name === "get_speed_snapshot"),
    toolCalls.map((message) => message.params?.name).join(",")
  );
  check("panel: 大数字渲染本轮速度", elements.get("tps").textContent === "51.3", elements.get("tps").textContent);
  check(
    "panel: 渲染最近 3 次平均",
    elements.get("liveRate").textContent === "52.0 tok/s",
    elements.get("liveRate").textContent
  );
  check("panel: 渲染首 token 延迟", elements.get("ttft").textContent === "0.50s", elements.get("ttft").textContent);
  check("panel: 渲染平均 token 间隔", elements.get("mspt").textContent === "19.5 ms", elements.get("mspt").textContent);
  check(
    "panel: 渲染本轮总 token",
    elements.get("turnTokens").textContent === "100 tok",
    elements.get("turnTokens").textContent
  );
  check("panel: 渲染状态", elements.get("phase").textContent === "空闲", elements.get("phase").textContent);
  check(
    "panel: HUD 按钮初始为打开",
    elements.get("hudToggle").textContent === "打开悬浮窗",
    elements.get("hudToggle").textContent
  );
  const hudClick = listeners.get("hudToggle:click");
  check("panel: HUD 按钮已绑定点击", typeof hudClick === "function");
  if (hudClick) {
    await hudClick();
    check(
      "panel: HUD 按钮调用 show_speed_hud",
      messages.some((message) => message.method === "tools/call" && message.params?.name === "show_speed_hud")
    );
    check(
      "panel: HUD 按钮切换为关闭",
      elements.get("hudToggle").textContent === "关闭悬浮窗",
      elements.get("hudToggle").textContent
    );
    await hudClick();
    check(
      "panel: HUD 按钮调用 hide_speed_hud",
      messages.some((message) => message.method === "tools/call" && message.params?.name === "hide_speed_hud")
    );
    check(
      "panel: HUD 按钮切回打开",
      elements.get("hudToggle").textContent === "打开悬浮窗",
      elements.get("hudToggle").textContent
    );
  }
  const historyRows = elements.get("history").children.filter((child) => child.className.includes("hrow"));
  check(
    "panel: 渲染最近几轮",
    historyRows.length === 2 && historyRows[0].children[1].textContent.includes("100 tok") &&
      historyRows[0].children[1].textContent.includes("51.3 tok/s"),
    historyRows.map((row) => row.children[1]?.textContent).join(" | ")
  );
  check("panel: 上报容器尺寸", methods.includes("ui/notifications/size-changed"));
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);