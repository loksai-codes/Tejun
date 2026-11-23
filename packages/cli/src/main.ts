// CLI logic, kept free of process I/O so tests can call it directly.
//
// Exit codes:
//   0  OK (for `run`: the simulation ran, even if the machine faulted)
//   1  the program or scenario has errors
//   2  could not run: usage error, unreadable or unwritable file, or internal error

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION, build, check, closest, formatDiagnostics, type StationIR } from "@tejun/compiler";
import {
  Plant,
  formatScenarioErrors,
  formatTimeline,
  parseScenario,
  parseTime,
  simulate,
  type Jam,
  type Scenario,
} from "@tejun/runtime";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** File access, injectable for tests. */
export interface CliIo {
  readFile(path: string): string;
  /** Create a directory and its parents if missing. */
  makeDir(path: string): void;
  writeFile(path: string, text: string): void;
}

const nodeIo: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  makeDir: (path) => void mkdirSync(path, { recursive: true }),
  writeFile: (path, text) => writeFileSync(path, text, "utf8"),
};

const USAGE = `tejun ${VERSION}

Usage:
  tejun check <file.tejun>              check a program and print diagnostics
  tejun build <file.tejun> [-o <dir>]   compile to IEC 61131-3 Structured Text (default dir: out)
  tejun run   <file.tejun> [options]    simulate a program and print a timeline

Run options:
  --scenario <file>          inputs over time (default: <file>.scenario next to the program, if any)
  --jam <sensor>[=on|off]    force a sensor stuck OFF (default) or ON; repeatable
  --until <time>             end time, e.g. 5s (default: the scenario's until, else 10s)
  --scan <time>              scan time, e.g. 20ms (default: 20ms)

Options:
  -h, --help       show this help
  -v, --version    show the version
`;

const fail = (code: number, en: string, ja: string, extra = ""): CliResult => ({
  code,
  stdout: "",
  stderr: `error: ${en}\nエラー: ${ja}\n${extra}`,
});

export function runCli(argv: readonly string[], io: CliIo = nodeIo): CliResult {
  try {
    return dispatch(argv, io);
  } catch (e) {
    // Never show a stack trace to the user.
    const detail = e instanceof Error ? e.message : String(e);
    return fail(
      2,
      `internal error: ${detail}`,
      `内部エラー: ${detail}`,
      "This is a bug in tejun. Please report it with the file you were checking.\n",
    );
  }
}

function dispatch(argv: readonly string[], io: CliIo): CliResult {
  const [command, ...args] = argv;

  if (command === undefined || command === "-h" || command === "--help") {
    return { code: 0, stdout: USAGE, stderr: "" };
  }
  if (command === "-v" || command === "--version") {
    return { code: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  if (command === "check") return checkCommand(args, io);
  if (command === "build") return buildCommand(args, io);
  if (command === "run") return runCommand(args, io);
  return fail(2, `unknown command '${command}'`, `不明なコマンド '${command}'`, `\n${USAGE}`);
}

/** Read a source file, or return the error result. */
function readSource(file: string, io: CliIo): { text: string } | { error: CliResult } {
  try {
    return { text: io.readFile(file) };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { error: fail(
      2,
      `cannot read '${file}': ${missing ? "no such file" : "it could not be read"}`,
      `'${file}' を読み込めません: ${missing ? "ファイルが存在しません" : "読み込めませんでした"}`,
    ) };
  }
}

function checkCommand(args: readonly string[], io: CliIo): CliResult {
  const usage = "\nUsage: tejun check <file.tejun>\n";
  const [file, ...extra] = args;
  if (file === undefined) {
    return fail(2, "'tejun check' needs a file", "'tejun check' にはファイルが必要です", usage);
  }
  if (extra.length > 0) {
    return fail(2, `unexpected argument '${extra[0]}'`, `予期しない引数 '${extra[0]}'`, usage);
  }
  const read = readSource(file, io);
  if ("error" in read) return read.error;

  const result = check(file, read.text);
  if (result.diagnostics.length === 0) return { code: 0, stdout: "OK\n", stderr: "" };
  return { code: 1, stdout: formatDiagnostics(result.diagnostics, result.source), stderr: "" };
}

function buildCommand(args: readonly string[], io: CliIo): CliResult {
  const usage = "\nUsage: tejun build <file.tejun> [-o <dir>]\n";
  let file: string | undefined;
  let outDir = "out";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-o" || arg === "--out") {
      const dir = args[++i];
      if (dir === undefined) return fail(2, `'${arg}' needs a directory`, `'${arg}' にはディレクトリが必要です`, usage);
      outDir = dir;
    } else if (file === undefined && !arg.startsWith("-")) {
      file = arg;
    } else {
      return fail(2, `unexpected argument '${arg}'`, `予期しない引数 '${arg}'`, usage);
    }
  }
  if (file === undefined) {
    return fail(2, "'tejun build' needs a file", "'tejun build' にはファイルが必要です", usage);
  }
  const read = readSource(file, io);
  if ("error" in read) return read.error;

  const result = build(file, read.text);
  if (!result.st) return { code: 1, stdout: formatDiagnostics(result.diagnostics, result.source), stderr: "" };

  const outPath = join(outDir, `${basename(file.replace(/\\/g, "/")).replace(/\.tejun$/, "")}.st`);
  const shown = outPath.replace(/\\/g, "/");
  try {
    io.makeDir(outDir);
    io.writeFile(outPath, result.st);
  } catch {
    return fail(2, `cannot write '${shown}'`, `'${shown}' に書き込めません`);
  }
  return { code: 0, stdout: `wrote ${shown}\n`, stderr: "" };
}

function runCommand(args: readonly string[], io: CliIo): CliResult {
  const usage = "\nUsage: tejun run <file.tejun> [--scenario <file>] [--jam <sensor>[=on|off]] [--until <time>] [--scan <time>]\n";
  let file: string | undefined;
  let scenarioPath: string | undefined;
  const jamArgs: string[] = [];
  let untilText: string | undefined;
  let scanText: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const takesValue = ["--scenario", "--jam", "--until", "--scan"].includes(arg);
    if (takesValue) {
      const value = args[++i];
      if (value === undefined) return fail(2, `'${arg}' needs a value`, `'${arg}' には値が必要です`, usage);
      if (arg === "--scenario") scenarioPath = value;
      if (arg === "--jam") jamArgs.push(value);
      if (arg === "--until") untilText = value;
      if (arg === "--scan") scanText = value;
    } else if (file === undefined && !arg.startsWith("-")) {
      file = arg;
    } else {
      return fail(2, `unexpected argument '${arg}'`, `予期しない引数 '${arg}'`, usage);
    }
  }
  if (file === undefined) return fail(2, "'tejun run' needs a file", "'tejun run' にはファイルが必要です", usage);

  const times: { untilMs?: number; scanMs?: number } = {};
  for (const [flag, text] of [["--until", untilText], ["--scan", scanText]] as const) {
    if (text === undefined) continue;
    const ms = parseTime(text);
    if (ms === undefined || ms <= 0) {
      return fail(2, `'${flag}' needs a time such as 5s or 20ms, found '${text}'`, `'${flag}' には 5s や 20ms のような時間が必要ですが、'${text}' が指定されています`);
    }
    if (flag === "--until") times.untilMs = ms;
    else times.scanMs = ms;
  }

  const read = readSource(file, io);
  if ("error" in read) return read.error;
  const result = check(file, read.text);
  if (!result.ir) return { code: 1, stdout: formatDiagnostics(result.diagnostics, result.source), stderr: "" };
  const ir = result.ir;

  const jams = parseJams(jamArgs, ir);
  if ("error" in jams) return jams.error;

  // An explicit --scenario must exist; the default one next to the program is optional.
  let scenario: Scenario | undefined;
  let shownScenario: string | undefined;
  const candidate = scenarioPath ?? file.replace(/\.tejun$/, ".scenario");
  if (scenarioPath !== undefined || candidate !== file) {
    let text: string | undefined;
    try {
      text = io.readFile(candidate);
    } catch (e) {
      if (scenarioPath !== undefined || (e as NodeJS.ErrnoException).code !== "ENOENT") {
        const r = readSource(candidate, io);
        if ("error" in r) return r.error;
      }
    }
    if (text !== undefined) {
      shownScenario = candidate.replace(/\\/g, "/");
      const parsed = parseScenario(text, ir, new Plant(ir).owned);
      if (!parsed.scenario) return { code: 1, stdout: formatScenarioErrors(parsed.errors, shownScenario), stderr: "" };
      scenario = parsed.scenario;
    }
  }

  const sim = simulate(ir, { ...(scenario ? { scenario } : {}), jams: jams.jams, ...times });
  return { code: 0, stdout: formatTimeline(ir, sim, { scenarioPath: shownScenario, jams: jams.jams }), stderr: "" };
}

function parseJams(specs: readonly string[], ir: StationIR): { jams: Jam[] } | { error: CliResult } {
  const inputs = ir.signals.filter((s) => s.direction === "input" && s.type === "bool").map((s) => s.name);
  const jams: Jam[] = [];
  for (const spec of specs) {
    const [sensor = "", rawValue = "off"] = spec.split("=");
    const value = rawValue.toLowerCase();
    if (!inputs.includes(sensor)) {
      const suggestion = closest(sensor, inputs);
      return {
        error: fail(
          2,
          `cannot jam '${sensor}': it is not a bool input`,
          `'${sensor}' はジャムできません: bool 型の入力ではありません`,
          suggestion ? `  = help: did you mean '${suggestion}'?\n` : "",
        ),
      };
    }
    if (!["on", "off", "true", "false"].includes(value)) {
      return { error: fail(2, `'--jam ${spec}': the value must be on or off`, `'--jam ${spec}': 値は on または off である必要があります`) };
    }
    jams.push({ sensor, value: value === "on" || value === "true" });
  }
  return { jams };
}
