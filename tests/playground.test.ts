// The playground's browser-independent logic.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "@tejun/compiler";
import { simulate, parseScenario, Plant } from "@tejun/runtime";
import { formatEvent, t } from "../packages/playground/src/logic/i18n.js";
import { LiveClock } from "../packages/playground/src/logic/live.js";
import { toMarkers } from "../packages/playground/src/logic/markers.js";
import { tejunLanguage } from "../packages/playground/src/logic/tejun-language.js";

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");

describe("toMarkers", () => {
  it("places a squiggle exactly on the diagnostic span, including after Japanese text", () => {
    const text = example("press_feeder.tejun").replace('"ワーク検出"', '"ワーク検出" saftey');
    const result = check("p.tejun", text);
    const [marker] = toMarkers(result.diagnostics, result.source, "en");
    const line = text.split("\n")[marker!.startLineNumber - 1]!;
    expect(line.slice(marker!.startColumn - 1, marker!.endColumn - 1)).toBe("saftey");
  });

  it("widens a zero-width span to one character", () => {
    const result = check("p.tejun", example("press_feeder.tejun").replace("conveyor on;", "conveyor on"));
    const [marker] = toMarkers(result.diagnostics, result.source, "en");
    expect(marker!.code).toBe("T0016");
    expect(marker!.endColumn - marker!.startColumn).toBe(1);
  });

  it("puts the chosen language first and the other language last", () => {
    const result = check("p.tejun", example("press_feeder.tejun").replace(/^\s*state Home.*\n/m, ""));
    const [en] = toMarkers(result.diagnostics, result.source, "en");
    const [ja] = toMarkers(result.diagnostics, result.source, "ja");
    expect(en!.message.split("\n")[0]).toBe("interlock violated: `conveyor` can be ON while `clamp.retracted` is false");
    expect(en!.message).toContain("path: Idle (at startup)");
    expect(en!.message.split("\n").at(-1)).toMatch(/^日本語: インターロック違反/);
    expect(ja!.message.split("\n")[0]).toMatch(/^インターロック違反/);
    expect(ja!.message.split("\n").at(-1)).toMatch(/^English: interlock violated/);
  });
});

describe("formatEvent", () => {
  const ir = check("p.tejun", example("press_feeder.tejun")).ir!;
  const units = new Map(ir.signals.map((s) => [s.name, s.unit]));
  const scenario = parseScenario(example("press_feeder.scenario"), ir, new Plant(ir).owned).scenario!;
  const { events } = simulate(ir, { scenario, jams: [{ sensor: "clamp_ext_ls", value: false }] });

  it("has a Japanese line for every event in a faulting run", () => {
    const ja = events.map((e) => formatEvent(e.event, "ja", units));
    expect(ja).toContain("Home で開始  · 出力: clamp_in");
    expect(ja).toContain("press_force = 12 kN (シナリオ)");
    expect(ja).toContain("故障 3 CLAMP_TIMEOUT: clamp_ext_ls が 2000 ms 以内にONになりません");
    expect(ja).toContain("Clamp → Stopped  · 出力: すべてOFF");
    expect(ja.every((line) => !/\b(start|FAULT|outputs)\b/.test(line))).toBe(true);
  });

  it("uses the CLI wording in English", () => {
    const en = events.map((e) => formatEvent(e.event, "en", units));
    expect(en).toContain("FAULT 3 CLAMP_TIMEOUT: clamp_ext_ls not ON within 2000 ms");
    expect(en).toContain("Clamp -> Stopped  · outputs: all OFF");
  });

  it("translates every interface string", () => {
    expect(t("run", "ja")).toBe("実行");
    expect(t("run", "en")).toBe("Run");
  });
});

describe("LiveClock", () => {
  it("converts real time to scans, carrying the remainder", () => {
    const clock = new LiveClock();
    expect(clock.scansFor(16, 1, 20)).toBe(0);
    expect(clock.scansFor(16, 1, 20)).toBe(1); // 32 ms
    expect(clock.scansFor(100, 0.25, 20)).toBe(1); // 12 + 25 ms
  });

  it("does not jump ahead after a long pause", () => {
    expect(new LiveClock().scansFor(60_000, 1, 20)).toBe(12);
  });
});

describe("tejunLanguage", () => {
  it("colours the compiler's keywords", () => {
    expect(tejunLanguage.keywords).toContain("interlock");
    expect(tejunLanguage.keywords).toContain("forever");
  });
});
