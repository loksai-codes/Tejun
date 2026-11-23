// CLI logic, kept free of process I/O so tests can call it directly.

import { VERSION } from "@tejun/compiler";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = `tejun ${VERSION}

Usage:
  tejun check <file.tejun>            check a program and print diagnostics
  tejun build <file.tejun> -o <dir>   compile to IEC 61131-3 Structured Text
  tejun run   <file.tejun>            simulate a program

Options:
  -h, --help       show this help
  -v, --version    show the version
`;

const PLANNED = new Set(["check", "build", "run"]);

export function runCli(argv: readonly string[]): CliResult {
  const [command] = argv;

  if (command === undefined || command === "-h" || command === "--help") {
    return { code: 0, stdout: USAGE, stderr: "" };
  }
  if (command === "-v" || command === "--version") {
    return { code: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  if (PLANNED.has(command)) {
    return {
      code: 1,
      stdout: "",
      stderr:
        `error: 'tejun ${command}' is not implemented yet\n` +
        `エラー: 'tejun ${command}' はまだ実装されていません\n`,
    };
  }
  return {
    code: 1,
    stdout: "",
    stderr:
      `error: unknown command '${command}'\n` +
      `エラー: 不明なコマンド '${command}'\n\n${USAGE}`,
  };
}
