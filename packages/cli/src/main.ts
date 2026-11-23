// CLI logic, kept free of process I/O so tests can call it directly.
//
// Exit codes:
//   0  OK
//   1  the program has errors
//   2  could not run: usage error, unreadable or unwritable file, or internal error

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION, build, check, formatDiagnostics } from "@tejun/compiler";

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
  tejun run   <file.tejun>              simulate a program

Options:
  -h, --help       show this help
  -v, --version    show the version
`;

const NOT_YET = new Set(["run"]);

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
  if (NOT_YET.has(command)) {
    return fail(
      2,
      `'tejun ${command}' is not implemented yet`,
      `'tejun ${command}' はまだ実装されていません`,
    );
  }
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
