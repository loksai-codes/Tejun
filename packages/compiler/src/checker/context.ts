// Shared state for the checker passes: the symbol table, diagnostic
// reporting, and helpers for walking statements and expressions.

import type * as A from "../ast.js";
import type { DeviceKind } from "../device-kinds.js";
import type { Diagnostic, DiagnosticCode } from "../diagnostics.js";
import type { SourceFile, Span } from "../source.js";

/** The built-in state that fault and E-stop handlers go to. */
export const STOPPED = "Stopped";

export interface SignalSymbol {
  kind: "signal";
  name: string;
  decl: A.IoDecl;
  direction: "input" | "output";
  type: "bool" | "real";
  /** Unit of a real signal; undefined when none was given. */
  unit: string | undefined;
  /** True when the declared unit is unknown (already reported), so unit checks are skipped. */
  unitInvalid: boolean;
  safety: boolean;
}

export interface DeviceSymbol {
  kind: "device";
  name: string;
  decl: A.DeviceDecl;
  /** Undefined when the kind is unknown (already reported). */
  deviceKind: DeviceKind | undefined;
  /** Parameter name -> wired signal, for valid parameters wired to valid signals. */
  wiring: Map<string, SignalSymbol>;
}

export type ValueSymbol = SignalSymbol | DeviceSymbol;

type Parts = Pick<Diagnostic, "message" | "messageJa" | "label" | "help" | "notes">;

export class CheckContext {
  readonly source: SourceFile;
  readonly station: A.Station;
  readonly diagnostics: Diagnostic[] = [];
  /** Signals and devices share one namespace. */
  readonly values = new Map<string, ValueSymbol>();
  /** First declaration of each state name. */
  readonly states = new Map<string, A.State>();
  /** Transition and handler targets that did not resolve (already reported). */
  readonly unresolvedTargets = new Set<A.Ident>();

  constructor(source: SourceFile, program: A.Program) {
    this.source = source;
    this.station = program.station;
  }

  error(code: DiagnosticCode, span: Span, parts: Parts): void {
    this.diagnostics.push({ code, severity: "error", span, ...parts });
  }

  signal(name: A.Ident): SignalSymbol | undefined {
    const s = this.values.get(name.name);
    return s?.kind === "signal" ? s : undefined;
  }

  device(name: A.Ident): DeviceSymbol | undefined {
    const s = this.values.get(name.name);
    return s?.kind === "device" ? s : undefined;
  }

  /** Declared states, skipping duplicates and a user-declared `Stopped`. */
  uniqueStates(): A.State[] {
    return this.station.sequence.states.filter((s) => this.states.get(s.name.name) === s);
  }
}

/** Where a top-level condition expression appears. */
export interface ConditionSite {
  expr: A.Expr;
  where: "interlock" | "state" | "handler";
  /** The state, for conditions inside a state. */
  state?: A.State;
}

/** Every top-level condition: interlocks, `when` conditions, handler triggers. */
export function conditionSites(station: A.Station): ConditionSite[] {
  const sites: ConditionSite[] = [];
  for (const i of station.interlocks) sites.push({ expr: i.condition, where: "interlock" });
  for (const state of station.sequence.states) {
    for (const s of state.statements) {
      if (s.kind === "When") sites.push({ expr: s.condition, where: "state", state });
    }
  }
  for (const h of station.handlers) {
    if (h.trigger.kind !== "FaultTrigger") sites.push({ expr: h.trigger, where: "handler" });
  }
  return sites;
}

/** Visit an expression and all its sub-expressions, parents first. */
export function walkExpr(expr: A.Expr, visit: (e: A.Expr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "LogicalExpr":
    case "CompareExpr":
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case "NotExpr":
      walkExpr(expr.operand, visit);
      break;
    case "NameRef":
    case "MemberRef":
    case "Quantity":
      break;
  }
}

/** Every timeout in the station (device actions and `when`s). */
export function timeouts(station: A.Station): A.Timeout[] {
  const out: A.Timeout[] = [];
  for (const state of station.sequence.states) {
    for (const s of state.statements) {
      if ((s.kind === "DeviceAction" || s.kind === "When") && s.timeout) out.push(s.timeout);
    }
  }
  return out;
}

export function isTransition(s: A.Statement): s is A.When | A.Goto {
  return s.kind === "When" || s.kind === "Goto";
}

export function isStep(s: A.Statement): s is A.DeviceAction | A.Hold {
  return s.kind === "DeviceAction" || s.kind === "Hold";
}

/** Short source text of a node, for messages. */
export function snippet(source: SourceFile, span: Span, max = 40): string {
  const text = source.text.slice(span.start, span.end).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
