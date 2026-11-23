// The checker: runs every check family over a parsed program and returns
// all diagnostics, sorted by position. Passes after `names` skip anything
// that did not resolve, so one typo does not cause a cascade of errors.

import type { Program } from "../ast.js";
import type { Diagnostic } from "../diagnostics.js";
import type { SourceFile } from "../source.js";
import { CheckContext } from "./context.js";
import { checkNames } from "./names.js";

export function runChecker(source: SourceFile, program: Program): Diagnostic[] {
  const ctx = new CheckContext(source, program);
  checkNames(ctx);
  return sortDiagnostics(ctx.diagnostics);
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => a.span.start - b.span.start || a.code.localeCompare(b.code));
}
