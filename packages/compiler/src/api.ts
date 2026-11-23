// Public entry points. Each one returns diagnostics as values and never
// throws for problems in the user's program.

import type { Program } from "./ast.js";
import { runChecker } from "./checker/index.js";
import { checkInterlocks } from "./checker/interlocks.js";
import { DiagnosticAbort, type Diagnostic } from "./diagnostics.js";
import { generateST } from "./codegen/st.js";
import { buildIR, type StationIR } from "./ir.js";
import { lexAll, type Token } from "./lexer.js";
import { Parser } from "./parser.js";
import { SourceFile } from "./source.js";

/** Run the lexer alone (used by tests and, later, editor highlighting). */
export function tokenize(source: SourceFile): { tokens: Token[]; diagnostics: Diagnostic[] } {
  try {
    return { tokens: lexAll(source), diagnostics: [] };
  } catch (e) {
    if (e instanceof DiagnosticAbort) return { tokens: [], diagnostics: [e.diagnostic] };
    throw e;
  }
}

export interface ParseResult {
  /** Undefined when there is a syntax error. */
  program: Program | undefined;
  diagnostics: Diagnostic[];
}

/** Lex and parse. Stops at the first syntax error. */
export function parse(source: SourceFile): ParseResult {
  try {
    return { program: new Parser(source).parseProgram(), diagnostics: [] };
  } catch (e) {
    if (e instanceof DiagnosticAbort) return { program: undefined, diagnostics: [e.diagnostic] };
    throw e;
  }
}

export interface CheckResult extends ParseResult {
  source: SourceFile;
  /** The state-graph IR; present only when there are no diagnostics. */
  ir?: StationIR;
}

/** Check a program: everything `tejun check` does. Parse, then run the checker. */
export function check(path: string, text: string): CheckResult {
  const source = new SourceFile(path, text);
  const parsed = parse(source);
  if (!parsed.program) return { source, ...parsed };
  const diagnostics = runChecker(source, parsed.program);
  if (diagnostics.length > 0) return { source, program: parsed.program, diagnostics };
  const ir = buildIR(parsed.program);
  const violations = checkInterlocks(ir, parsed.program, source);
  if (violations.length > 0) return { source, program: parsed.program, diagnostics: violations };
  return { source, program: parsed.program, diagnostics, ir };
}

export interface BuildResult extends CheckResult {
  /** Generated Structured Text; present only when the program checked clean. */
  st?: string;
}

/** Check a program and, if it is clean, generate Structured Text. */
export function build(path: string, text: string): BuildResult {
  const result = check(path, text);
  if (!result.ir) return result;
  return { ...result, st: generateST(result.ir, { sourcePath: result.source.path }) };
}
