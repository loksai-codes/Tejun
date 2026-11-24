// T0101 undefined names, T0102 duplicate or built-in names.
// Runs first and fills the symbol table the other passes use.

import type * as A from "../ast.js";
import { DEVICE_KINDS, POSITION_MISMATCH } from "../device-kinds.js";
import { closest } from "../suggest.js";
import { STOPPED, conditionSites, timeouts, walkExpr, type CheckContext } from "./context.js";

export function checkNames(ctx: CheckContext): void {
  declareSignals(ctx);
  declareDevices(ctx);
  declareStates(ctx);
  checkFaultNames(ctx);
  resolveReferences(ctx);
}

/** POSITION_MISMATCH is raised by the built-in device position check only. */
function checkFaultNames(ctx: CheckContext): void {
  const st = ctx.station;
  const faults: A.Ident[] = [
    ...st.interlocks.flatMap((i) => (i.kind === "ConditionInterlock" ? [i.fault] : [])),
    ...timeouts(st).flatMap((t) => (t.kind === "WithinTimeout" ? [t.fault] : [])),
  ];
  for (const fault of faults) {
    if (fault.name !== POSITION_MISMATCH) continue;
    ctx.error("T0102", fault.span, {
      message: `\`${POSITION_MISMATCH}\` is a built-in fault and cannot be raised by the program`,
      messageJa: `\`${POSITION_MISMATCH}\` は組み込みの故障のため、プログラムから発生させることはできません`,
      label: "built-in fault",
      help: "it is raised automatically when a device's sensors disagree with its tracked position; choose another name for this fault",
    });
  }
}

function duplicate(ctx: CheckContext, name: A.Ident, first: A.Ident, what: string, whatJa: string): void {
  ctx.error("T0102", name.span, {
    message: `${what} \`${name.name}\` is already declared`,
    messageJa: `${whatJa} \`${name.name}\` はすでに宣言されています`,
    label: "declared again here",
    help: `the first declaration is on line ${first.span.line}; rename one of them`,
  });
}

function declareSignals(ctx: CheckContext): void {
  for (const decl of ctx.station.io.decls) {
    const existing = ctx.values.get(decl.name.name);
    if (existing) {
      duplicate(ctx, decl.name, existing.decl.name, "the name", "名前");
      continue;
    }
    ctx.values.set(decl.name.name, {
      kind: "signal",
      name: decl.name.name,
      decl,
      direction: decl.direction,
      type: decl.type.kind === "BoolType" ? "bool" : "real",
      unit: decl.type.kind === "RealType" ? decl.type.unit?.name : undefined,
      unitInvalid: false,
      safety: decl.safety !== undefined,
    });
  }
}

function declareDevices(ctx: CheckContext): void {
  for (const decl of ctx.station.devices) {
    const existing = ctx.values.get(decl.name.name);
    if (existing) {
      duplicate(ctx, decl.name, existing.decl.name, "the name", "名前");
      continue;
    }
    ctx.values.set(decl.name.name, {
      kind: "device",
      name: decl.name.name,
      decl,
      deviceKind: DEVICE_KINDS.get(decl.deviceKind.name),
      wiring: new Map(),
    });
  }
}

function declareStates(ctx: CheckContext): void {
  for (const state of ctx.station.sequence.states) {
    if (state.name.name === STOPPED) {
      ctx.error("T0102", state.name.span, {
        message: "`Stopped` is a built-in state and cannot be declared",
        messageJa: "`Stopped` は組み込みの状態のため宣言できません",
        label: "built-in state",
        help: "handlers go to `Stopped` automatically; choose another name for this state",
      });
      continue;
    }
    const existing = ctx.states.get(state.name.name);
    if (existing) {
      duplicate(ctx, state.name, existing.name, "state", "状態");
      continue;
    }
    ctx.states.set(state.name.name, state);
  }
}

function resolveReferences(ctx: CheckContext): void {
  const st = ctx.station;

  for (const device of st.devices) {
    for (const arg of device.args) resolveValue(ctx, arg.signal);
  }
  for (const i of st.interlocks) {
    if (i.kind === "RequiresInterlock") resolveValue(ctx, i.output);
  }
  for (const site of conditionSites(st)) {
    walkExpr(site.expr, (e) => {
      if (e.kind === "NameRef") resolveValue(ctx, e.name);
      if (e.kind === "MemberRef") resolveValue(ctx, e.object);
    });
  }
  for (const state of st.sequence.states) {
    for (const s of state.statements) {
      if (s.kind === "OutputOn") resolveValue(ctx, s.output);
      if (s.kind === "DeviceAction") resolveValue(ctx, s.device);
      if (s.kind === "When" || s.kind === "Goto") resolveState(ctx, s.target);
    }
  }
  for (const h of st.handlers) resolveState(ctx, h.target);
}

function resolveValue(ctx: CheckContext, name: A.Ident): void {
  if (ctx.values.has(name.name)) return;
  const suggestion = closest(name.name, ctx.values.keys());
  ctx.error("T0101", name.span, {
    message: `undefined name \`${name.name}\``,
    messageJa: `未定義の名前 \`${name.name}\``,
    label: "not declared",
    help: suggestion
      ? `did you mean \`${suggestion}\`?`
      : "declare it as a signal in the `io` block or as a `device`",
  });
}

function resolveState(ctx: CheckContext, name: A.Ident): void {
  if (name.name === STOPPED || ctx.states.has(name.name)) return;
  ctx.unresolvedTargets.add(name);
  const suggestion = closest(name.name, [...ctx.states.keys(), STOPPED]);
  ctx.error("T0101", name.span, {
    message: `undefined state \`${name.name}\``,
    messageJa: `未定義の状態 \`${name.name}\``,
    label: "no such state",
    help: suggestion
      ? `did you mean \`${suggestion}\`?`
      : `add \`state ${name.name} { … }\` to the sequence`,
  });
}
