// CLI logic, kept free of process I/O so tests can call it directly.
//
// Exit codes:
//   0  OK
//   1  the program has errors
//   2  could not check: usage error, unreadable file, or internal error

import { readFileSync } from "node:fs";
import { VERSION, check, formatDiagnostics } from "@tejun/compiler";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** File access, injectable for tests. */
export interface CliIo {
  readFile(path: string): string;
}

const nodeIo: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
};

const USAGE = `tejun ${VERSION}

Usage:
  tejun check <file.tejun>            check a program and print diagnostics
  tejun build <file.tejun> -o <dir>   compile to IEC 61131-3 Structured Text
  tejun run   <file.tejun>            simulate a program

Options:
  -h, --help       show this help
  -v, --version    show the version
`;

const NOT_YET = new Set(["build", "run"]);

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
  if (NOT_YET.has(command)) {
    return fail(
      2,
      `'tejun ${command}' is not implemented yet`,
      `'tejun ${command}' はまだ実装されていません`,
    );
  }
  return fail(2, `unknown command '${command}'`, `不明なコマンド '${command}'`, `\n${USAGE}`);
}

function checkCommand(args: readonly string[], io: CliIo): CliResult {
  const [file, ...extra] = args;
  if (file === undefined) {
    return fail(2, "'tejun check' needs a file", "'tejun check' にはファイルが必要です", "\nUsage: tejun check <file.tejun>\n");
  }
  if (extra.length > 0) {
    return fail(2, `unexpected argument '${extra[0]}'`, `予期しない引数 '${extra[0]}'`, "\nUsage: tejun check <file.tejun>\n");
  }

  let text: string;
  try {
    text = io.readFile(file);
  } catch (e) {
    const reason = (e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "it could not be read";
    const reasonJa = (e as NodeJS.ErrnoException).code === "ENOENT" ? "ファイルが存在しません" : "読み込めませんでした";
    return fail(2, `cannot read '${file}': ${reason}`, `'${file}' を読み込めません: ${reasonJa}`);
  }

  const result = check(file, text);
  if (result.diagnostics.length === 0) return { code: 0, stdout: "OK\n", stderr: "" };
  return { code: 1, stdout: formatDiagnostics(result.diagnostics, result.source), stderr: "" };
}
