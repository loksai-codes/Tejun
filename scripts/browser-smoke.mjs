// Browser smoke test for the playground: drives a real Chromium-based browser
// (Edge or Chrome, headless) over the Chrome DevTools Protocol, with no extra
// dependencies. It runs the press feeder, types an error and undoes it, jams
// a sensor, switches to Japanese, runs the other examples, tries light mode
// and a phone-width screen, and saves screenshots. Exits 1 if any check fails
// or the page logs an error.
//
// Usage:
//   npm run build:playground
//   npx --prefix packages/playground vite preview --port 4173   (from packages/playground)
//   node scripts/browser-smoke.mjs http://localhost:4173/ <screenshot-dir>
// Set TEJUN_BROWSER to the browser executable if it is not found.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error("usage: node scripts/browser-smoke.mjs <url> <screenshot-dir>");
  process.exit(2);
}
const CANDIDATES = [
  process.env.TEJUN_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const EDGE = CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error("no Chromium-based browser found; set TEJUN_BROWSER");
  process.exit(2);
}
const PORT = 9333;
mkdirSync(outDir, { recursive: true });
const profile = join(outDir, "profile");

const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--window-size=1440,1100",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 50 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) throw new Error("Edge did not start");

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const problems = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  } else if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params.entry.level)) {
    problems.push(`log.${msg.params.entry.level}: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const key = async (key, code, vk, modifiers = 0) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, modifiers });
  }
};
const clickButton = (text) =>
  evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "clicked"; })()`);
const status = () =>
  evaluate(`(() => ({
    state: document.querySelector(".sim-status")?.innerText.replace(/\\s+/g, " "),
    errors: document.querySelector(".diagnostics .count")?.textContent,
    firstError: document.querySelector(".diagnostics li")?.innerText.replace(/\\s+/g, " ") ?? null,
    squiggles: document.querySelectorAll(".squiggly-error").length,
    runDisabled: [...document.querySelectorAll("button")].find(b => b.textContent.includes("Run") || b.textContent.includes("実行"))?.disabled ?? null,
    logTail: [...document.querySelectorAll(".log li")].slice(-6).map(li => li.innerText),
    lamps: [...document.querySelectorAll(".output-lamp.on")].map(e => e.innerText.trim()),
  }))()`);

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
// Wait for the app to render (a cold dev server serves Monaco as many modules).
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evaluate("!!document.querySelector('.sim-status') && !!document.querySelector('.monaco-editor .view-lines')")) break;
}
await sleep(500);

const report = {};
report.title = await evaluate("document.title");
report.rootHtmlLength = await evaluate("document.getElementById('root').innerHTML.length");
if (report.rootHtmlLength === 0) {
  console.log(JSON.stringify({ ...report, problems }, null, 2));
  ws.close();
  edge.kill();
  process.exit(1);
}
report.initial = await status();
await shot("1-initial");

try {
report.run = await clickButton("Run");
await sleep(4200);
report.afterRun = await status();
await shot("2-running");

// Introduce an error at the start of the program.
report.afterRunRoot = await evaluate("document.getElementById('root').innerHTML.length");
const lines = await evaluate(`(() => { const r = document.querySelector(".monaco-editor .view-lines").getBoundingClientRect(); return { x: r.left + 4, y: r.top + 6 }; })()`);
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: lines.x, y: lines.y, button: "left", clickCount: 1 });
}
await sleep(200);
report.focused = await evaluate("document.activeElement?.className || document.activeElement?.tagName");
await key("Home", "Home", 36, 2); // Ctrl+Home
await send("Input.insertText", { text: "x" });
await sleep(800);
report.withError = await status();
await shot("3-error");

await key("z", "KeyZ", 90, 2); // Ctrl+Z
await sleep(800);
report.afterUndo = await status();

// Jam the clamp's extended sensor, reset, and run until the fault.
report.jam = await evaluate(`(() => {
  const select = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "clamp_ext_ls=off"));
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  setter.call(select, "clamp_ext_ls=off");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return select.value;
})()`);
report.reset = await clickButton("Reset");
report.runJam = await clickButton("Run");
await sleep(4000);
report.afterJam = await status();
await shot("4-jam-fault");

report.lang = await clickButton("日本語");
await sleep(500);
report.japanese = await status();
await shot("5-japanese");

// other-examples: load each and run it.
for (const id of ["conveyor_sorter", "pick_place", "press_station"]) {
  await evaluate(`(() => {
    const select = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === ${JSON.stringify(id)}));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(id)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await sleep(600);
  await clickButton("実行");
  await sleep(3000);
  report[id] = await status();
  await shot(`7-${id}`);
}
// Light colour scheme.
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await sleep(500);
await shot("5b-light-mode");
// Narrow screen.
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await sleep(800);
report.scrollWidth = await evaluate("[document.documentElement.scrollWidth, window.innerWidth]");
await shot("6-mobile");

} catch (e) {
  report.failure = String(e);
}
report.problems = problems;

const checks = [
  ["page renders", report.rootHtmlLength > 0],
  ["no step failed", report.failure === undefined],
  ["press feeder runs and reaches Idle", /Idle/.test(report.afterRun?.state ?? "")],
  ["a typed error is reported and squiggled", report.withError?.errors === "1" && report.withError?.squiggles > 0],
  ["Run is disabled while there are errors", report.withError?.runDisabled === true],
  ["undo clears the error", report.afterUndo?.errors === "0"],
  ["a jammed sensor causes CLAMP_TIMEOUT", /CLAMP_TIMEOUT/.test(report.afterJam?.state ?? "")],
  ["Japanese interface", /状態/.test(report.japanese?.state ?? "")],
  ["other examples run without errors", report.conveyor_sorter?.errors === "0" && report.pick_place?.errors === "0"],
  ["press station (Motor + Cylinder) runs without errors or faults", report.press_station?.errors === "0" && !/MISMATCH|TIMEOUT|NO_START|NO_STOP|NO_FORCE|OVERLOAD/.test(report.press_station?.state ?? "")],
  ["no horizontal scroll at phone width", report.scrollWidth?.[0] <= report.scrollWidth?.[1]],
  ["no console errors or warnings", problems.length === 0],
];
report.checks = Object.fromEntries(checks.map(([name, ok]) => [name, ok ? "pass" : "FAIL"]));
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
