// Scenario files for `tejun run`: when the inputs that no device drives
// change, and when the run ends.
//
//   # comment
//   at 1 s     part_present = on
//   at 4 s     press_force = 12 kN
//   follow vacuum_ok = vacuum after 100 ms
//   until 10 s
//
// Safety inputs start ON; every other input starts OFF (or 0).

import { closest, type SignalIR, type StationIR } from "@tejun/compiler";

export interface ScenarioSet {
  atMs: number;
  signal: string;
  value: boolean | number;
  line: number;
}

/** A bool input that copies a bool output after a delay. */
export interface ScenarioFollow {
  input: string;
  output: string;
  delayMs: number;
  line: number;
}

export interface Scenario {
  /** Sorted by time; lines at the same time keep file order. */
  sets: ScenarioSet[];
  follows: ScenarioFollow[];
  untilMs: number | undefined;
}

export interface ScenarioError {
  line: number;
  message: string;
  messageJa: string;
  help?: string;
}

const TIME = String.raw`(\d+(?:\.\d+)?)\s*(ms|s)`;
const AT = new RegExp(String.raw`^at\s+${TIME}\s+(\w+)\s*=\s*(.+)$`);
const FOLLOW = new RegExp(String.raw`^follow\s+(\w+)\s*=\s*(\w+)(?:\s+after\s+${TIME})?$`);
const UNTIL = new RegExp(String.raw`^until\s+${TIME}$`);
const LINE_HELP = "lines look like `at 1 s part_present = on`, `follow vacuum_ok = vacuum after 100 ms` or `until 10 s`";

/** Parse a duration such as `500ms`, `1.5 s`. Returns ms, or undefined. */
export function parseTime(text: string): number | undefined {
  const m = new RegExp(`^${TIME}$`).exec(text.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  return Math.round(m[2] === "s" ? value * 1000 : value);
}

const toMs = (value: string, unit: string) => Math.round(unit === "s" ? Number(value) * 1000 : Number(value));

/**
 * Parse and validate a scenario against a station. `owned` lists sensors driven
 * by the simulated devices, which a scenario may not set.
 */
export function parseScenario(
  text: string,
  ir: StationIR,
  owned: ReadonlyMap<string, string>,
): { scenario: Scenario | undefined; errors: ScenarioError[] } {
  const errors: ScenarioError[] = [];
  const sets: ScenarioSet[] = [];
  const follows: ScenarioFollow[] = [];
  let untilMs: number | undefined;
  const signals = new Map(ir.signals.map((s) => [s.name, s]));
  const inputNames = ir.signals.filter((s) => s.direction === "input").map((s) => s.name);

  const err = (line: number, message: string, messageJa: string, help?: string) =>
    errors.push({ line, message, messageJa, ...(help ? { help } : {}) });

  /** Check that `name` is an input a scenario may drive. */
  const input = (line: number, name: string): SignalIR | undefined => {
    const signal = signals.get(name);
    if (!signal) {
      const suggestion = closest(name, inputNames);
      err(line, `unknown input \`${name}\``, `不明な入力 \`${name}\``, suggestion ? `did you mean \`${suggestion}\`?` : undefined);
      return undefined;
    }
    if (signal.direction === "output") {
      err(line, `\`${name}\` is an output; scenarios set inputs`, `\`${name}\` は出力です。シナリオでは入力を設定します`);
      return undefined;
    }
    const device = owned.get(name);
    if (device) {
      err(
        line,
        `\`${name}\` is driven by the simulated device \`${device}\``,
        `\`${name}\` はシミュレーションのデバイス \`${device}\` が駆動します`,
        `to make it stick, run with \`--jam ${name}\` (stuck OFF) or \`--jam ${name}=on\``,
      );
      return undefined;
    }
    return signal;
  };

  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1;
      const content = raw.replace(/#.*/, "").trim();
      if (content === "") return;

      let m = AT.exec(content);
      if (m) {
        const [, value, unit, name, rawValue] = m as unknown as [string, string, string, string, string];
        const signal = input(line, name);
        if (!signal) return;
        const parsed = parseValue(signal, rawValue.trim());
        if ("error" in parsed) {
          err(line, parsed.error[0], parsed.error[1], parsed.help);
          return;
        }
        sets.push({ atMs: toMs(value, unit), signal: name, value: parsed.value, line });
        return;
      }

      m = FOLLOW.exec(content);
      if (m) {
        const [, inName, outName, delay, delayUnit] = m as unknown as [string, string, string, string | undefined, string | undefined];
        const signal = input(line, inName);
        const out = signals.get(outName);
        if (signal && signal.type !== "bool") {
          err(line, `\`${inName}\` is real; only bool inputs can follow an output`, `\`${inName}\` は real 型です。出力に追従できるのは bool 型の入力だけです`);
          return;
        }
        if (!out || out.direction !== "output" || out.type !== "bool") {
          const outputs = ir.signals.filter((s) => s.direction === "output").map((s) => s.name);
          const suggestion = closest(outName, outputs);
          err(
            line,
            `\`${outName}\` is not a bool output`,
            `\`${outName}\` は bool 型の出力ではありません`,
            suggestion ? `did you mean \`${suggestion}\`?` : undefined,
          );
          return;
        }
        if (!signal) return;
        if (follows.some((f) => f.input === inName)) {
          err(line, `\`${inName}\` already follows an output`, `\`${inName}\` はすでに出力に追従しています`);
          return;
        }
        follows.push({ input: inName, output: outName, delayMs: delay ? toMs(delay, delayUnit!) : 0, line });
        return;
      }

      m = UNTIL.exec(content);
      if (m) {
        untilMs = toMs(m[1]!, m[2]!);
        return;
      }

      err(line, "cannot understand this line", "この行を解釈できません", LINE_HELP);
    });

  for (const s of sets) {
    const f = follows.find((x) => x.input === s.signal);
    if (f) {
      err(s.line, `\`${s.signal}\` follows \`${f.output}\` (line ${f.line}), so it cannot also be set`, `\`${s.signal}\` は \`${f.output}\` に追従しているため設定できません (${f.line}行目)`);
    }
  }

  if (errors.length > 0) return { scenario: undefined, errors: errors.sort((a, b) => a.line - b.line) };
  sets.sort((a, b) => a.atMs - b.atMs || a.line - b.line);
  return { scenario: { sets, follows, untilMs }, errors };
}

function parseValue(
  signal: SignalIR,
  text: string,
): { value: boolean | number } | { error: [string, string]; help?: string } {
  if (signal.type === "bool") {
    const lower = text.toLowerCase();
    if (lower === "on" || lower === "true") return { value: true };
    if (lower === "off" || lower === "false") return { value: false };
    return { error: [`\`${signal.name}\` is bool; expected on or off, found \`${text}\``, `\`${signal.name}\` は bool 型です。on または off が必要ですが \`${text}\` が指定されています`] };
  }
  const m = /^(-?\d+(?:\.\d+)?)\s*(\w+)?$/.exec(text);
  if (!m) {
    return { error: [`\`${signal.name}\` is real; expected a number, found \`${text}\``, `\`${signal.name}\` は real 型です。数値が必要ですが \`${text}\` が指定されています`] };
  }
  const unit = m[2];
  if (unit !== signal.unit) {
    const want = signal.unit ?? "no unit";
    return {
      error: [`\`${signal.name}\` is in ${want}, but the value has ${unit ?? "no unit"}`, `\`${signal.name}\` の単位は ${want} ですが、値の単位は ${unit ?? "なし"} です`],
      help: signal.unit ? `write \`${m[1]} ${signal.unit}\`` : `write \`${m[1]}\``,
    };
  }
  return { value: Number(m[1]) };
}

/** Format scenario errors in the same spirit as compiler diagnostics. */
export function formatScenarioErrors(errors: readonly ScenarioError[], path: string): string {
  return (
    errors
      .map((e) =>
        [
          `error: ${path}:${e.line}: ${e.message}`,
          ...(e.help ? [`  = help: ${e.help}`] : []),
          `  = 日本語: ${e.messageJa}`,
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}
