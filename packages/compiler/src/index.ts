// Tejun compiler: source -> lexer -> parser -> AST -> checker -> IR -> codegen.

export const VERSION = "0.0.0";

export { SourceFile, displayWidth, codePointLength, type Span } from "./source.js";
export {
  DIAGNOSTIC_CODES,
  formatDiagnostic,
  formatDiagnostics,
  type Diagnostic,
  type DiagnosticCode,
} from "./diagnostics.js";
