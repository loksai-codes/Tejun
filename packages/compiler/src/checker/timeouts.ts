// T0201 wait with no timeout.
//
// A device action always waits for its feedback sensor. A `when` waits
// unless a bare `-> State` follows it in the same state (then it is a
// branch). Every wait needs `within <time> else fault <CODE>` or an explicit
// `forever`.

import { snippet, type CheckContext } from "./context.js";

const HELP = "add `within <time> else fault <CODE>`, or `forever` if waiting forever is intended";

export function checkTimeouts(ctx: CheckContext): void {
  for (const state of ctx.station.sequence.states) {
    state.statements.forEach((s, i) => {
      if (s.kind === "DeviceAction" && !s.timeout) {
        const text = `${s.device.name}.${s.action.name}`;
        ctx.error("T0201", s.span, {
          message: `\`${text}\` can wait forever: it has no timeout`,
          messageJa: `\`${text}\` にタイムアウトがないため、永久に待つ可能性があります`,
          label: "no timeout",
          help: HELP,
        });
      }
      if (s.kind === "When" && !s.timeout) {
        const isBranch = state.statements.slice(i + 1).some((t) => t.kind === "Goto");
        if (isBranch) return;
        const span = ctx.source.span(s.span.start, s.condition.span.end);
        const text = snippet(ctx.source, span);
        ctx.error("T0201", span, {
          message: `\`${text}\` can wait forever: it has no timeout`,
          messageJa: `\`${text}\` にタイムアウトがないため、永久に待つ可能性があります`,
          label: "no timeout",
          help: "add `within <time> else fault <CODE>` before `->`, or `forever` if waiting forever is intended",
        });
      }
    });
  }
}
