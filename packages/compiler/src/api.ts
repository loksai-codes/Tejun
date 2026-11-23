// Public entry points. Each one returns diagnostics as values and never
// throws for problems in the user's program.

import type { Program } from "./ast.js";
import { runChecker } from "./checker/index.js";
import { DiagnosticAbort, type Diagnostic } from "./diagnostics.js";
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
}

/** Check a program: everything `tejun check` does. Parse, then run the checker. */
export function check(path: string, text: string): CheckResult {
  const source = new SourceFile(path, text);
  const parsed = parse(source);
  if (!parsed.program) return { source, ...parsed };
  return { source, program: parsed.program, diagnostics: runChecker(source, parsed.program) };
}
