// Interface text and event-log lines in English and Japanese.

import type { FaultCause, TimelineEvent } from "@tejun/runtime";
import { describeEvent } from "@tejun/runtime";

export type Lang = "en" | "ja";

const STRINGS = {
  title: { en: "Tejun Playground", ja: "Tejun プレイグラウンド" },
  tagline: {
    en: "A safety-checked language for one factory station, compiled to IEC 61131-3 Structured Text",
    ja: "1台の設備のための安全検証つき言語。IEC 61131-3 Structured Text にコンパイルします",
  },
  example: { en: "Example", ja: "サンプル" },
  custom: { en: "(edited)", ja: "(編集済み)" },
  run: { en: "Run", ja: "実行" },
  pause: { en: "Pause", ja: "一時停止" },
  reset: { en: "Reset", ja: "リセット" },
  speed: { en: "Speed", ja: "速度" },
  jam: { en: "Jam a sensor", ja: "センサを固着" },
  noJam: { en: "No jam", ja: "固着なし" },
  stuckOff: { en: "stuck OFF", ja: "OFF固着" },
  stuckOn: { en: "stuck ON", ja: "ON固着" },
  useScenario: { en: "Play scenario", ja: "シナリオを再生" },
  errors: { en: "Errors", ja: "エラー" },
  noErrors: { en: "No errors: the program checks clean.", ja: "エラーなし: プログラムは検証済みです。" },
  fixErrorsToRun: { en: "Fix the errors to run the program.", ja: "実行するにはエラーを修正してください。" },
  eventLog: { en: "Event log", ja: "イベントログ" },
  structuredText: { en: "Structured Text", ja: "Structured Text" },
  scenario: { en: "Scenario", ja: "シナリオ" },
  stLastGood: { en: "Showing the last program that checked clean.", ja: "最後に検証に成功したプログラムを表示しています。" },
  copy: { en: "Copy", ja: "コピー" },
  copied: { en: "Copied", ja: "コピーしました" },
  inputs: { en: "Inputs (click to switch)", ja: "入力 (クリックで切替)" },
  outputs: { en: "Outputs", ja: "出力" },
  devices: { en: "Devices", ja: "デバイス" },
  states: { en: "States", ja: "状態" },
  estop: { en: "E-STOP", ja: "非常停止" },
  estopRelease: { en: "Released", ja: "解除中" },
  estopPressed: { en: "Pressed", ja: "押下中" },
  stateLabel: { en: "State", ja: "状態" },
  faultLabel: { en: "Fault", ja: "故障" },
  none: { en: "none", ja: "なし" },
  time: { en: "Time", ja: "時間" },
  follows: { en: "follows", ja: "追従:" },
  noEvents: { en: "Press Run to start the simulation.", ja: "「実行」を押すとシミュレーションが始まります。" },
  scenarioErrors: { en: "Scenario errors", ja: "シナリオのエラー" },
  scenarioHelp: {
    en: "Lines: `at 1 s part_present = on`, `follow vacuum_ok = vacuum after 100 ms`, `until 10 s`. Applied on Reset.",
    ja: "書式: `at 1 s part_present = on`、`follow vacuum_ok = vacuum after 100 ms`、`until 10 s`。リセット時に反映されます。",
  },
  language: { en: "日本語", ja: "English" },
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(key: StringKey, lang: Lang): string {
  return STRINGS[key][lang];
}

/** One event-log line (without the time). */
export function formatEvent(event: TimelineEvent, lang: Lang, units: ReadonlyMap<string, string | undefined>): string {
  if (lang === "en") return describeEvent(event, units).replace(/\s{2,}outputs:/, "  · outputs:");
  const outs = (outputs: string[] | undefined) =>
    outputs === undefined ? "" : `  · 出力: ${outputs.length > 0 ? outputs.join(", ") : "すべてOFF"}`;
  switch (event.kind) {
    case "start":
      return `${event.state} で開始${outs(event.outputs)}`;
    case "input": {
      const unit = units.get(event.signal);
      const value = typeof event.value === "boolean" ? ` ${event.value ? "ON" : "OFF"}` : ` = ${event.value}${unit ? ` ${unit}` : ""}`;
      return `${event.signal}${value} (${sourceJa(event.source)})`;
    }
    case "fault":
      return `故障 ${event.number} ${event.fault}: ${causeJa(event.cause)}`;
    case "transition": {
      const reason = event.reason ? ` (${event.reason.replace(/^E-stop:/, "非常停止:")})` : "";
      return `${event.from} → ${event.to}${reason}${outs(event.outputs)}`;
    }
    case "violation":
      return `!! インターロック違反: ${event.interlock} (Tejun の不具合です。報告してください)`;
  }
}

function sourceJa(source: string): string {
  if (source === "scenario") return "シナリオ";
  if (source === "default") return "初期値";
  if (source === "manual") return "手動";
  if (source === "jammed") return "固着";
  const follows = /^follows (\w+)$/.exec(source);
  if (follows) return `${follows[1]} に追従`;
  return source; // a device name
}

function causeJa(c: FaultCause): string {
  switch (c.kind) {
    case "step":
      return `${c.sensor} が ${c.ms} ms 以内にONになりません`;
    case "wait":
      return `${c.ms} ms 以内に遷移しません`;
    case "monitor":
      return `${c.condition} が偽です`;
  }
}
