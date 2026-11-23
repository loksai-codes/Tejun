// T0202 unreachable state, T0204 fault with no `on fault` handler, T0205 no
// E-stop handler, T0206 dead-end state, T0209 handler not going to Stopped.
//
// The fault and E-stop handlers apply in every state, so requiring both (and
// requiring them to go to Stopped) gives every state a path to Stopped.

import type * as A from "../ast.js";
import { STOPPED, isTransition, timeouts, type CheckContext } from "./context.js";

export function checkReachability(ctx: CheckContext): void {
  checkStateGraph(ctx);
  checkHandlers(ctx);
}

function checkStateGraph(ctx: CheckContext): void {
  const states = ctx.uniqueStates();
  const start = states[0];
  if (!start) return;

  for (const state of states) {
    if (state.statements.some(isTransition)) continue;
    ctx.error("T0206", state.name.span, {
      message: `state \`${state.name.name}\` has no way out`,
      messageJa: `状態 \`${state.name.name}\` から抜け出す遷移がありません`,
      label: "dead end",
      help: `add a transition, e.g. \`-> ${start.name.name}\`; otherwise only a fault or E-stop can leave this state`,
    });
  }

  // An unresolved target is probably meant to reach one of the "unreachable"
  // states, so reporting both would be noise.
  if (ctx.unresolvedTargets.size > 0) return;

  const reached = new Set<string>([start.name.name]);
  const queue: A.State[] = [start];
  for (let state = queue.shift(); state; state = queue.shift()) {
    for (const s of state.statements) {
      if (!isTransition(s)) continue;
      const next = ctx.states.get(s.target.name);
      if (next && !reached.has(next.name.name)) {
        reached.add(next.name.name);
        queue.push(next);
      }
    }
  }
  for (const state of states) {
    if (reached.has(state.name.name)) continue;
    ctx.error("T0202", state.name.span, {
      message: `state \`${state.name.name}\` can never be reached`,
      messageJa: `状態 \`${state.name.name}\` に到達できません`,
      label: "unreachable",
      help: `no transition leads here from the start state \`${start.name.name}\``,
    });
  }
}

function checkHandlers(ctx: CheckContext): void {
  const st = ctx.station;

  for (const h of st.handlers) {
    const target = h.target.name;
    if (target === STOPPED || !ctx.states.has(target)) continue;
    ctx.error("T0209", h.target.span, {
      message: `handler goes to \`${target}\` instead of \`Stopped\``,
      messageJa: `ハンドラが \`Stopped\` ではなく \`${target}\` に遷移しています`,
      label: "should be `Stopped`",
      help: "fault and E-stop handlers must stop the machine with `-> Stopped`; restarting is a separate, deliberate step",
    });
  }

  const hasFaultHandler = st.handlers.some((h) => h.trigger.kind === "FaultTrigger");
  const faults: A.Ident[] = [
    ...st.interlocks.flatMap((i) => (i.kind === "ConditionInterlock" ? [i.fault] : [])),
    ...timeouts(st).flatMap((t) => (t.kind === "WithinTimeout" ? [t.fault] : [])),
  ].sort((a, b) => a.span.start - b.span.start);
  const firstFault = faults[0];
  if (firstFault && !hasFaultHandler) {
    ctx.error("T0204", firstFault.span, {
      message: `fault \`${firstFault.name}\` can be raised, but there is no \`on fault\` handler`,
      messageJa: `故障 \`${firstFault.name}\` が発生する可能性がありますが、\`on fault\` ハンドラがありません`,
      label: "nowhere to go",
      help: "add `on fault { outputs safe; -> Stopped }` at the end of the station",
    });
  }

  const isSafetyInput = (e: A.Expr) => {
    if (e.kind !== "NameRef") return false;
    const signal = ctx.signal(e.name);
    return signal?.safety === true && signal.direction === "input" && signal.type === "bool";
  };
  const hasEstopHandler = st.handlers.some(
    (h) => h.trigger.kind === "NotExpr" && isSafetyInput(h.trigger.operand),
  );
  if (!hasEstopHandler) {
    const safety = st.io.decls.find(
      (d) => d.safety && d.direction === "input" && d.type.kind === "BoolType",
    )?.name.name;
    // A handler like `on not estop_ok` whose input just lacks `safety`.
    const unmarked = st.handlers
      .map((h) => (h.trigger.kind === "NotExpr" && h.trigger.operand.kind === "NameRef" ? ctx.signal(h.trigger.operand.name) : undefined))
      .find((sig) => sig?.direction === "input" && sig.type === "bool");
    ctx.error("T0205", st.name.span, {
      message: `station \`${st.name.name}\` has no E-stop handler`,
      messageJa: `ステーション \`${st.name.name}\` に非常停止ハンドラがありません`,
      label: "no E-stop handler",
      help: safety
        ? `add \`on not ${safety} { outputs safe; -> Stopped }\``
        : unmarked
          ? `\`on not ${unmarked.name}\` exists, but \`${unmarked.name}\` is not marked \`safety\`; add \`safety\` to its declaration on line ${unmarked.decl.span.line}`
          : "declare the E-stop input, e.g. `input estop_ok : bool @ %IX0.7 safety`, and add `on not estop_ok { outputs safe; -> Stopped }`",
    });
  }
}
