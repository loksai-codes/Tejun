// Abstract syntax tree. Mirrors docs/grammar.ebnf. Every node carries a
// source span, and every union is discriminated by `kind`.

import type { Span } from "./source.js";

interface NodeBase {
  span: Span;
}

export interface Ident extends NodeBase {
  kind: "Ident";
  name: string;
}

export interface StringLit extends NodeBase {
  kind: "StringLit";
  value: string;
}

export interface NumberLit extends NodeBase {
  kind: "NumberLit";
  value: number;
  /** Source text, e.g. "1.5", for messages and codegen. */
  text: string;
}

// ===== Program structure =====

export interface Program extends NodeBase {
  kind: "Program";
  station: Station;
}

export interface Station extends NodeBase {
  kind: "Station";
  name: Ident;
  label: StringLit | undefined;
  io: IoBlock;
  devices: DeviceDecl[];
  interlocks: Interlock[];
  sequence: Sequence;
  handlers: Handler[];
}

// ===== I/O =====

export interface IoBlock extends NodeBase {
  kind: "IoBlock";
  decls: IoDecl[];
}

export interface IoDecl extends NodeBase {
  kind: "IoDecl";
  direction: "input" | "output";
  name: Ident;
  type: TypeRef;
  address: Address;
  label: StringLit | undefined;
  /** Span of the `safety` keyword, if present. */
  safety: Span | undefined;
  range: RangeSpec | undefined;
}

export type TypeRef = BoolType | RealType;

export interface BoolType extends NodeBase {
  kind: "BoolType";
}

export interface RealType extends NodeBase {
  kind: "RealType";
  unit: Ident | undefined;
}

export interface Address extends NodeBase {
  kind: "Address";
  /** Source text, e.g. "%IX0.1". */
  text: string;
  area: "I" | "Q";
  size: "X" | "W";
  byte: number;
  /** Bit number 0..7 for X addresses; undefined for W. */
  bit: number | undefined;
}

export interface RangeSpec extends NodeBase {
  kind: "Range";
  min: NumberLit;
  max: NumberLit;
}

// ===== Devices =====

export interface DeviceDecl extends NodeBase {
  kind: "DeviceDecl";
  name: Ident;
  deviceKind: Ident;
  args: DeviceArg[];
}

export interface DeviceArg extends NodeBase {
  kind: "DeviceArg";
  param: Ident;
  signal: Ident;
}

// ===== Interlocks =====

export type Interlock = NeverInterlock | RequiresInterlock | ConditionInterlock;

/** `interlock never <cond>`: cond must never hold. */
export interface NeverInterlock extends NodeBase {
  kind: "NeverInterlock";
  condition: Expr;
}

/** `interlock <output> requires <cond>`: output may be ON only while cond holds. */
export interface RequiresInterlock extends NodeBase {
  kind: "RequiresInterlock";
  output: Ident;
  condition: Expr;
}

/** `interlock <cond> else fault <CODE>`: cond must always hold. */
export interface ConditionInterlock extends NodeBase {
  kind: "ConditionInterlock";
  condition: Expr;
  fault: Ident;
}

// ===== Sequence and states =====

export interface Sequence extends NodeBase {
  kind: "Sequence";
  name: Ident;
  states: State[];
}

export interface State extends NodeBase {
  kind: "State";
  name: Ident;
  statements: Statement[];
}

export type Statement = OutputOn | DeviceAction | Hold | When | Goto;

export interface OutputOn extends NodeBase {
  kind: "OutputOn";
  output: Ident;
}

export interface DeviceAction extends NodeBase {
  kind: "DeviceAction";
  device: Ident;
  action: Ident;
  timeout: Timeout | undefined;
}

export interface Hold extends NodeBase {
  kind: "Hold";
  duration: Duration;
}

export interface When extends NodeBase {
  kind: "When";
  condition: Expr;
  timeout: Timeout | undefined;
  target: Ident;
}

export interface Goto extends NodeBase {
  kind: "Goto";
  target: Ident;
}

export type Timeout = WithinTimeout | ForeverTimeout;

export interface WithinTimeout extends NodeBase {
  kind: "WithinTimeout";
  duration: Duration;
  fault: Ident;
}

export interface ForeverTimeout extends NodeBase {
  kind: "ForeverTimeout";
}

export interface Duration extends NodeBase {
  kind: "Duration";
  value: NumberLit;
  unit: Ident;
}

// ===== Handlers =====

export interface Handler extends NodeBase {
  kind: "Handler";
  /** `on fault` or `on <expr>`. */
  trigger: FaultTrigger | Expr;
  target: Ident;
}

export interface FaultTrigger extends NodeBase {
  kind: "FaultTrigger";
}

// ===== Expressions =====

export type Expr = LogicalExpr | NotExpr | CompareExpr | NameRef | MemberRef | Quantity;

export interface LogicalExpr extends NodeBase {
  kind: "LogicalExpr";
  op: "and" | "or";
  left: Expr;
  right: Expr;
}

export interface NotExpr extends NodeBase {
  kind: "NotExpr";
  operand: Expr;
}

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface CompareExpr extends NodeBase {
  kind: "CompareExpr";
  op: CompareOp;
  left: Expr;
  right: Expr;
}

/** A signal name. */
export interface NameRef extends NodeBase {
  kind: "NameRef";
  name: Ident;
}

/** A device state such as `clamp.retracted`. */
export interface MemberRef extends NodeBase {
  kind: "MemberRef";
  object: Ident;
  member: Ident;
}

/** A number with an optional unit, such as `40 kN`. */
export interface Quantity extends NodeBase {
  kind: "Quantity";
  value: NumberLit;
  unit: Ident | undefined;
}
