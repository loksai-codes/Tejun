// Tejun compiler: source -> lexer -> parser -> AST -> checker -> IR -> codegen.

export { VERSION } from "./version.js";

export { SourceFile, displayWidth, codePointLength, type Span } from "./source.js";
export {
  DIAGNOSTIC_CODES,
  formatDiagnostic,
  formatDiagnostics,
  type Diagnostic,
  type DiagnosticCode,
} from "./diagnostics.js";
export { KEYWORDS, type Token, type TokenKind } from "./lexer.js";
export { tokenize, parse, check, build, type ParseResult, type CheckResult, type BuildResult } from "./api.js";
export { generateST, type StOptions } from "./codegen/st.js";
export type * as AST from "./ast.js";
export {
  buildIR,
  outputsOn,
  type StationIR,
  type SignalIR,
  type DeviceIR,
  type InterlockIR,
  type StateIR,
  type StepIR,
  type TransitionIR,
  type TimeoutIR,
  type HandlersIR,
  type ExprIR,
} from "./ir.js";
export { DEVICE_KINDS, CYLINDER, type DeviceKind } from "./device-kinds.js";
