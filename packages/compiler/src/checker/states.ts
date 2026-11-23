// T0207 statement after a transition, T0208 more than one step in a state.
//
// Together these fix the meaning of a state: its outputs are ON for the whole
// state, its one step (a device action or `hold`) runs, then its transitions
// are tried top to bottom.

import type * as A from "../ast.js";
import { isStep, isTransition, snippet, type CheckContext } from "./context.js";

export function checkStates(ctx: CheckContext): void {
  for (const state of ctx.station.sequence.states) checkState(ctx, state);
}

function checkState(ctx: CheckContext, state: A.State): void {
  let goto: A.Goto | undefined;
  let sawTransition = false;
  let step: A.Statement | undefined;

  for (const s of state.statements) {
    const text = snippet(ctx.source, s.span);

    if (goto) {
      ctx.error("T0207", s.span, {
        message: `\`${text}\` comes after \`-> ${goto.target.name}\` and is never reached`,
        messageJa: `\`${text}\` は \`-> ${goto.target.name}\` の後にあるため実行されません`,
        label: "never reached",
        help: "a bare `-> State` must be the last statement in a state",
      });
      continue;
    }
    if (isTransition(s)) {
      sawTransition = true;
      if (s.kind === "Goto") goto = s;
      continue;
    }
    if (sawTransition) {
      ctx.error("T0207", s.span, {
        message: `\`${text}\` comes after a transition`,
        messageJa: `\`${text}\` が遷移の後に書かれています`,
        label: "after a transition",
        help: "write outputs and the step first, then the transitions",
      });
    }
    if (isStep(s)) {
      if (step) {
        ctx.error("T0208", s.span, {
          message: `state \`${state.name.name}\` has more than one step`,
          messageJa: `状態 \`${state.name.name}\` に複数のステップがあります`,
          label: "second step",
          help: `a state waits for one thing at a time; move \`${text}\` into its own state`,
        });
      } else {
        step = s;
      }
    }
  }
}
