// Public entry points. Each one returns diagnostics as values and never
// throws for problems in the user's program.

import { DiagnosticAbort, type Diagnostic } from "./diagnostics.js";
import { lexAll, type Token } from "./lexer.js";
import type { SourceFile } from "./source.js";

/** Run the lexer alone (used by tests and, later, editor highlighting). */
export function tokenize(source: SourceFile): { tokens: Token[]; diagnostics: Diagnostic[] } {
  try {
    return { tokens: lexAll(source), diagnostics: [] };
  } catch (e) {
    if (e instanceof DiagnosticAbort) return { tokens: [], diagnostics: [e.diagnostic] };
    throw e;
  }
}
