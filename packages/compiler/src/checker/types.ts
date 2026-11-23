// T0103 type mismatch. Types every condition expression as bool or real;
// unit and range checks on comparisons are delegated to units.ts.

import type * as A from "../ast.js";
import { conditionSites, snippet, type CheckContext } from "./context.js";
import { checkComparison, checkLiteralUnit, type RealType } from "./units.js";

type ExprType = { kind: "bool" } | RealType | { kind: "error" };

const BOOL: ExprType = { kind: "bool" };
const ERROR: ExprType = { kind: "error" };

export function checkTypes(ctx: CheckContext): void {
  for (const site of conditionSites(ctx.station)) {
    requireBool(ctx, site.expr, typeOf(ctx, site.expr), "a condition");
  }
  for (const state of ctx.station.sequence.states) {
    for (const s of state.statements) {
      if (s.kind !== "OutputOn") continue;
      const signal = ctx.signal(s.output);
      if (signal?.type === "real") {
        ctx.error("T0103", s.output.span, {
          message: `\`${signal.name}\` is a real signal and cannot be switched on`,
          messageJa: `\`${signal.name}\` は real 型の信号のためONにできません`,
          label: "not a bool output",
          help: "only bool outputs can be switched on",
        });
      }
    }
  }
}

function typeText(t: ExprType): string {
  if (t.kind === "bool") return "bool";
  if (t.kind === "real") {
    if (t.literal) return t.unit ? `a number in ${t.unit}` : "a number";
    return t.unit ? `real<${t.unit}>` : "real";
  }
  return "invalid";
}

function requireBool(ctx: CheckContext, expr: A.Expr, t: ExprType, what: string): void {
  if (t.kind !== "real") return;
  const text = snippet(ctx.source, expr.span);
  const example = t.signal ? `\`${text} > 0${t.unit ? ` ${t.unit}` : ""}\`` : "a comparison";
  ctx.error("T0103", expr.span, {
    message: `${what} must be true or false, but \`${text}\` is ${typeText(t)}`,
    messageJa: `条件は真偽値である必要がありますが、\`${text}\` は ${typeText(t)} です`,
    label: "not true/false",
    help: `compare it with a limit, e.g. ${example}`,
  });
}

function typeOf(ctx: CheckContext, expr: A.Expr): ExprType {
  switch (expr.kind) {
    case "NameRef": {
      const symbol = ctx.values.get(expr.name.name);
      if (!symbol) return ERROR;
      if (symbol.kind === "device") {
        const state = Object.keys(symbol.deviceKind?.states ?? {}).at(-1) ?? "retracted";
        ctx.error("T0103", expr.span, {
          message: `\`${symbol.name}\` is a device, not a signal`,
          messageJa: `\`${symbol.name}\` はデバイスであり、信号ではありません`,
          label: "device used as a value",
          help: `use one of its states, e.g. \`${symbol.name}.${state}\``,
        });
        return ERROR;
      }
      if (symbol.type === "bool") return BOOL;
      return { kind: "real", unit: symbol.unit, unitInvalid: symbol.unitInvalid, signal: symbol };
    }

    case "MemberRef": {
      const symbol = ctx.values.get(expr.object.name);
      if (!symbol) return ERROR;
      if (symbol.kind === "signal") {
        ctx.error("T0103", expr.span, {
          message: `\`${symbol.name}\` is a signal and has no \`.${expr.member.name}\``,
          messageJa: `\`${symbol.name}\` は信号のため \`.${expr.member.name}\` はありません`,
          label: "not a device",
          help: "only devices have states, e.g. `clamp.retracted`",
        });
        return ERROR;
      }
      // Unknown kinds and states are reported by devices.ts.
      return symbol.deviceKind && expr.member.name in symbol.deviceKind.states ? BOOL : ERROR;
    }

    case "Quantity": {
      const valid = expr.unit === undefined || checkLiteralUnit(ctx, expr.unit);
      return { kind: "real", unit: expr.unit?.name, unitInvalid: !valid, literal: expr };
    }

    case "NotExpr": {
      requireBool(ctx, expr.operand, typeOf(ctx, expr.operand), "the operand of `not`");
      return BOOL;
    }

    case "LogicalExpr": {
      requireBool(ctx, expr.left, typeOf(ctx, expr.left), `each side of \`${expr.op}\``);
      requireBool(ctx, expr.right, typeOf(ctx, expr.right), `each side of \`${expr.op}\``);
      return BOOL;
    }

    case "CompareExpr":
      typeComparison(ctx, expr, typeOf(ctx, expr.left), typeOf(ctx, expr.right));
      return BOOL;
  }
}

function typeComparison(ctx: CheckContext, cmp: A.CompareExpr, left: ExprType, right: ExprType): void {
  if (left.kind === "error" || right.kind === "error") return;
  const l = snippet(ctx.source, cmp.left.span);
  const r = snippet(ctx.source, cmp.right.span);
  const ordering = cmp.op !== "==" && cmp.op !== "!=";

  if (ordering && (left.kind === "bool" || right.kind === "bool")) {
    const boolSide = left.kind === "bool" ? l : r;
    ctx.error("T0103", cmp.span, {
      message: `\`${cmp.op}\` compares numbers, but \`${boolSide}\` is bool`,
      messageJa: `\`${cmp.op}\` は数値を比較しますが、\`${boolSide}\` は bool です`,
      label: "bool in a numeric comparison",
      help: `use a bool signal directly as a condition: \`${boolSide}\` or \`not ${boolSide}\``,
    });
    return;
  }
  if (left.kind !== right.kind) {
    ctx.error("T0103", cmp.span, {
      message: `cannot compare \`${l}\` (${typeText(left)}) with \`${r}\` (${typeText(right)})`,
      messageJa: `\`${l}\` (${typeText(left)}) と \`${r}\` (${typeText(right)}) は比較できません`,
      label: "different types",
      help: "both sides of a comparison must be bool, or both numbers",
    });
    return;
  }
  if (left.kind === "real" && right.kind === "real") checkComparison(ctx, cmp, left, right);
}
