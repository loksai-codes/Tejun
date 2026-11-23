// T0104 unit mismatch, T0105 unknown unit, T0106 value outside the declared
// range. Declaration and duration checks run as a pass; comparison checks
// are called from types.ts while it types expressions.

import type * as A from "../ast.js";
import { closest } from "../suggest.js";
import { snippet, type CheckContext, type SignalSymbol } from "./context.js";

/** Units a real signal may be declared in. Tejun never converts between them. */
export const PHYSICAL_UNITS: readonly string[] = ["N", "kN", "mm", "m", "bar", "kPa", "MPa", "degC", "rpm", "A", "V"];
/** Units a duration may use. */
export const TIME_UNITS: readonly string[] = ["ms", "s"];
const ALL_UNITS = [...PHYSICAL_UNITS, ...TIME_UNITS];

/** Scale to a base unit, for suggesting the converted value in help text. */
const SCALE: Readonly<Record<string, { dimension: string; factor: number }>> = {
  N: { dimension: "force", factor: 1 },
  kN: { dimension: "force", factor: 1000 },
  mm: { dimension: "length", factor: 0.001 },
  m: { dimension: "length", factor: 1 },
  kPa: { dimension: "pressure", factor: 1e3 },
  bar: { dimension: "pressure", factor: 1e5 },
  MPa: { dimension: "pressure", factor: 1e6 },
  ms: { dimension: "time", factor: 0.001 },
  s: { dimension: "time", factor: 1 },
};

/** Type of a real-valued expression, as seen by the unit checks. */
export interface RealType {
  kind: "real";
  unit: string | undefined;
  /** The unit is unknown and was already reported; skip unit checks. */
  unitInvalid: boolean;
  /** Set when the expression is a signal (for range checks). */
  signal?: SignalSymbol;
  /** Set when the expression is a number literal. */
  literal?: A.Quantity;
}

export function checkUnits(ctx: CheckContext): void {
  for (const decl of ctx.station.io.decls) checkDeclaration(ctx, decl);
  for (const state of ctx.station.sequence.states) {
    for (const s of state.statements) {
      if (s.kind === "Hold") checkDuration(ctx, s.duration);
      if ((s.kind === "DeviceAction" || s.kind === "When") && s.timeout?.kind === "WithinTimeout") {
        checkDuration(ctx, s.timeout.duration);
      }
    }
  }
}

function checkDeclaration(ctx: CheckContext, decl: A.IoDecl): void {
  const symbol = ctx.values.get(decl.name.name);
  const own = symbol?.kind === "signal" && symbol.decl === decl ? symbol : undefined;

  if (decl.type.kind === "RealType" && decl.type.unit && !PHYSICAL_UNITS.includes(decl.type.unit.name)) {
    const unit = decl.type.unit;
    const isTime = TIME_UNITS.includes(unit.name);
    unknownUnit(ctx, unit, PHYSICAL_UNITS, isTime ? "`ms` and `s` are for durations, not signals" : undefined);
    if (own) own.unitInvalid = true;
  }

  if (decl.range) {
    if (decl.type.kind === "BoolType") {
      ctx.error("T0103", decl.range.span, {
        message: `\`${decl.name.name}\` is bool, so it cannot have a range`,
        messageJa: `\`${decl.name.name}\` は bool のため範囲を指定できません`,
        label: "range on a bool signal",
        help: "ranges apply to real signals, e.g. `real<kN> … range 0..50`",
      });
    } else if (decl.range.min.value > decl.range.max.value) {
      const { min, max } = decl.range;
      ctx.error("T0106", decl.range.span, {
        message: `the range ${min.text}..${max.text} is empty`,
        messageJa: `範囲 ${min.text}..${max.text} は空です`,
        label: "minimum is larger than maximum",
        help: `write the smaller number first: \`range ${max.text}..${min.text}\``,
      });
    }
  }
}

function checkDuration(ctx: CheckContext, d: A.Duration): void {
  const unit = d.unit.name;
  if (TIME_UNITS.includes(unit)) return;
  if (PHYSICAL_UNITS.includes(unit)) {
    ctx.error("T0104", d.unit.span, {
      message: `a duration needs \`ms\` or \`s\`, found \`${unit}\``,
      messageJa: `時間には \`ms\` または \`s\` が必要ですが、\`${unit}\` が指定されています`,
      label: "not a time unit",
      help: `write the time in ms or s, e.g. \`${d.value.text} ms\``,
    });
    return;
  }
  unknownUnit(ctx, d.unit, TIME_UNITS, "durations use `ms` or `s`");
}

/** Report an unknown unit on a number literal in an expression. Returns false if unknown. */
export function checkLiteralUnit(ctx: CheckContext, unit: A.Ident): boolean {
  if (ALL_UNITS.includes(unit.name)) return true;
  unknownUnit(ctx, unit, ALL_UNITS);
  return false;
}

function unknownUnit(ctx: CheckContext, unit: A.Ident, candidates: readonly string[], fallback?: string): void {
  const suggestion = closest(unit.name, candidates);
  const caseOnly = suggestion !== undefined && suggestion.toLowerCase() === unit.name.toLowerCase();
  ctx.error("T0105", unit.span, {
    message: `unknown unit \`${unit.name}\``,
    messageJa: `不明な単位 \`${unit.name}\``,
    label: "unknown unit",
    help: suggestion
      ? `${caseOnly ? "units are case-sensitive; " : ""}did you mean \`${suggestion}\`?`
      : (fallback ?? `known units: ${candidates.join(", ")}`),
  });
}

/** Check that the two sides of a numeric comparison use the same unit, then the range. */
export function checkComparison(ctx: CheckContext, cmp: A.CompareExpr, left: RealType, right: RealType): void {
  if (left.unitInvalid || right.unitInvalid) return;
  if (left.unit !== right.unit) {
    unitMismatch(ctx, cmp, left, right);
    return;
  }
  checkRange(ctx, cmp, left, right);
}

function unitMismatch(ctx: CheckContext, cmp: A.CompareExpr, left: RealType, right: RealType): void {
  const quote = (e: A.Expr) => `\`${snippet(ctx.source, e.span)}\``;
  const l = quote(cmp.left);
  const r = quote(cmp.right);
  // When one side is a number literal, point at it: that is usually what to fix.
  const lit = left.literal ? left : right.literal ? right : undefined;
  const other = lit === left ? right : left;
  const span = lit?.literal?.span ?? cmp.span;

  if (lit && lit.unit === undefined && other.unit !== undefined) {
    const [litText, otherText] = lit === left ? [l, r] : [r, l];
    ctx.error("T0104", span, {
      message: `${litText} has no unit, but ${otherText} is in ${other.unit}`,
      messageJa: `${litText} に単位がありませんが、${otherText} は ${other.unit} です`,
      label: "missing unit",
      help: `write \`${lit.literal!.value.text} ${other.unit}\``,
    });
    return;
  }

  const unitText = (u: string | undefined) => u ?? "no unit";
  let help = "both sides of a comparison need the same unit";
  if (lit && lit.unit && other.unit) {
    const from = SCALE[lit.unit];
    const to = SCALE[other.unit];
    if (from && to && from.dimension === to.dimension) {
      const converted = Number(((lit.literal!.value.value * from.factor) / to.factor).toPrecision(6));
      help = `Tejun does not convert units; write \`${converted} ${other.unit}\``;
    }
  } else if (lit && lit.unit && other.unit === undefined) {
    help = `declare the signal's unit, e.g. \`real<${lit.unit}>\`, or drop the unit from the number`;
  }
  ctx.error("T0104", span, {
    message: `cannot compare ${l} (${unitText(left.unit)}) with ${r} (${unitText(right.unit)})`,
    messageJa: `単位が一致しません: ${l} (${unitText(left.unit)}) と ${r} (${unitText(right.unit)})`,
    label: "unit mismatch",
    help,
  });
}

type Flipped = Record<A.CompareOp, A.CompareOp>;
const FLIP: Flipped = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };

/** A comparison between a ranged signal and a number that can never change result. */
function checkRange(ctx: CheckContext, cmp: A.CompareExpr, left: RealType, right: RealType): void {
  const signalSide = left.signal ? left : right.signal ? right : undefined;
  const literalSide = signalSide === left ? right : left;
  const range = signalSide?.signal?.decl.range;
  if (!signalSide || !literalSide.literal || !range || range.min.value > range.max.value) return;

  const op = signalSide === left ? cmp.op : FLIP[cmp.op];
  const v = literalSide.literal.value.value;
  const min = range.min.value;
  const max = range.max.value;
  const always = constantResult(op, v, min, max);
  if (always === undefined) return;

  const name = signalSide.signal!.name;
  const unit = signalSide.unit ? ` ${signalSide.unit}` : "";
  const text = snippet(ctx.source, cmp.span);
  const word = always ? "true" : "false";
  const wordJa = always ? "真" : "偽";
  ctx.error("T0106", literalSide.literal.span, {
    message: `\`${text}\` is always ${word}: \`${name}\` is declared as ${range.min.text}..${range.max.text}${unit}`,
    messageJa: `\`${text}\` は常に${wordJa}です: \`${name}\` の範囲は ${range.min.text}..${range.max.text}${unit} です`,
    label: `outside ${range.min.text}..${range.max.text}`,
    help: "check the limit; a comparison that never changes protects nothing",
  });
}

/** For x in [min, max], whether `x op v` is always true, always false, or neither. */
function constantResult(op: A.CompareOp, v: number, min: number, max: number): boolean | undefined {
  switch (op) {
    case "<":
      return max < v ? true : min >= v ? false : undefined;
    case "<=":
      return max <= v ? true : min > v ? false : undefined;
    case ">":
      return min > v ? true : max <= v ? false : undefined;
    case ">=":
      return min >= v ? true : max < v ? false : undefined;
    case "==":
      return v < min || v > max ? false : undefined;
    case "!=":
      return v < min || v > max ? true : undefined;
  }
}
