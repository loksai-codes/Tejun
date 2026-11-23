// Diagnostics: error codes, the Diagnostic shape, and the Rust/Elm-style
// text format.
//
//   error[T0010]: expected `:`, found keyword `bool`
//     --> examples/x.tejun:4:25
//      |
//    4 |     input  part_present bool @ %IX0.0
//      |                         ^^^^ expected `:`
//      |
//      = help: ...
//      = 日本語: ...

import { displayWidth, TAB_WIDTH, type SourceFile, type Span } from "./source.js";

/**
 * Every diagnostic code with a one-line title. Ranges:
 * T00xx syntax, T01xx names/types/units, T02xx safety, T03xx I/O, T04xx devices.
 * Each code needs a fixture in tests/fixtures/errors/ (enforced by a test).
 */
export const DIAGNOSTIC_CODES = {
  T0001: "unexpected character",
  T0002: "unterminated string",
  T0003: "malformed I/O address",
  T0010: "unexpected token",
  T0011: "unclosed brace at end of file",
  T0012: "unknown keyword",
  T0013: "keyword used as a name",
  T0014: "section out of order or repeated",
  T0015: "chained comparison",
  T0016: "missing `;` between statements",

  T0101: "undefined name",
  T0102: "duplicate name",
  T0103: "type mismatch",
  T0104: "unit mismatch",
  T0105: "unknown unit",
  T0106: "value outside the declared range",

  T0201: "wait with no timeout",
  T0202: "unreachable state",
  T0203: "interlock violated",
  T0204: "fault with no `on fault` handler",
  T0205: "no E-stop handler",
  T0206: "dead-end state",
  T0207: "statement after a transition",
  T0208: "more than one step in a state",
  T0209: "handler does not go to `Stopped`",

  T0301: "two signals on one address",
  T0302: "address does not match the signal direction",
  T0303: "address does not match the signal type",
  T0304: "input used as an output",
  T0305: "safety signal used in sequence logic",
  T0306: "`safety` on a signal that cannot be a safety input",

  T0401: "unknown device kind",
  T0402: "missing device parameter",
  T0403: "unknown or repeated device parameter",
  T0404: "device parameter wired to the wrong kind of signal",
  T0405: "unknown device action or state",
  T0406: "output driven from two places",
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning";
  /** English message, shown in the header line. */
  message: string;
  /** Japanese message, shown in the `= 日本語:` line. */
  messageJa: string;
  span: Span;
  /** Text after the caret underline. */
  label?: string;
  /** Extra `= ...` lines before help, e.g. "path: Idle -> Clamp". */
  notes?: string[];
  help?: string;
}

/**
 * Thrown inside the lexer and parser to stop at the first syntax error.
 * Never escapes the compiler's public API.
 */
export class DiagnosticAbort extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

export function formatDiagnostic(d: Diagnostic, source: SourceFile): string {
  const lineNo = String(d.span.line);
  const pad = " ".repeat(lineNo.length);
  const raw = source.lineText(d.span.line);
  const lineStart = source.lineStart(d.span.line);
  const startInLine = Math.min(d.span.start - lineStart, raw.length);
  // A span that runs past its first line is underlined to the end of that line.
  const endInLine =
    d.span.endLine === d.span.line ? Math.min(d.span.end - lineStart, raw.length) : raw.length;

  const before = displayWidth(raw.slice(0, startInLine));
  const carets = Math.max(1, displayWidth(raw.slice(startInLine, endInLine)));
  const shown = raw.replace(/\t/g, " ".repeat(TAB_WIDTH));

  const lines = [
    `${d.severity}[${d.code}]: ${d.message}`,
    `${pad}--> ${source.path}:${d.span.line}:${d.span.col}`,
    `${pad} |`,
    `${lineNo} | ${shown}`,
    `${pad} | ${" ".repeat(before)}${"^".repeat(carets)}${d.label ? ` ${d.label}` : ""}`,
    `${pad} |`,
    ...(d.notes ?? []).map((n) => `${pad} = ${n}`),
    ...(d.help ? [`${pad} = help: ${d.help}`] : []),
    `${pad} = 日本語: ${d.messageJa}`,
  ];
  return lines.map((l) => l.trimEnd()).join("\n");
}

/** All diagnostics, separated by blank lines, with a trailing newline. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[], source: SourceFile): string {
  return diagnostics.map((d) => formatDiagnostic(d, source)).join("\n\n") + "\n";
}
