// T0301 duplicate address, T0302 address area vs direction, T0303 address
// size vs type, T0304 input used as an output, T0305 safety signal in
// sequence logic, T0306 `safety` on a signal that cannot be a safety input.

import type * as A from "../ast.js";
import { conditionSites, walkExpr, type CheckContext } from "./context.js";

const ADDRESS_HELP = "inputs use %I addresses and outputs use %Q addresses";
const SIZE_HELP = "bool signals use bit addresses like %IX0.0; real signals use word addresses like %IW2";

export function checkIo(ctx: CheckContext): void {
  checkDeclarations(ctx);
  checkWrites(ctx);
  checkSafetyUse(ctx);
}

function checkDeclarations(ctx: CheckContext): void {
  const byAddress = new Map<string, A.IoDecl>();
  for (const decl of ctx.station.io.decls) {
    const { address, name } = decl;
    const isInput = decl.direction === "input";

    if (address.area !== (isInput ? "I" : "Q")) {
      const areaText = address.area === "I" ? "input" : "output";
      ctx.error("T0302", address.span, {
        message: `${decl.direction} \`${name.name}\` is on ${areaText} address \`${address.text}\``,
        messageJa: `${isInput ? "入力" : "出力"} \`${name.name}\` が${address.area === "I" ? "入力" : "出力"}アドレス \`${address.text}\` に割り当てられています`,
        label: `${areaText} address`,
        help: ADDRESS_HELP,
      });
    }

    const isBool = decl.type.kind === "BoolType";
    if (address.size !== (isBool ? "X" : "W")) {
      ctx.error("T0303", address.span, {
        message: `${isBool ? "bool" : "real"} signal \`${name.name}\` is on a ${address.size === "X" ? "bit" : "word"} address \`${address.text}\``,
        messageJa: `${isBool ? "bool" : "real"} 型の信号 \`${name.name}\` が${address.size === "X" ? "ビット" : "ワード"}アドレス \`${address.text}\` に割り当てられています`,
        label: `${address.size === "X" ? "bit" : "word"} address`,
        help: SIZE_HELP,
      });
    }

    const first = byAddress.get(address.text);
    if (first) {
      ctx.error("T0301", address.span, {
        message: `address \`${address.text}\` is already used by \`${first.name.name}\``,
        messageJa: `アドレス \`${address.text}\` はすでに \`${first.name.name}\` が使用しています`,
        label: "used twice",
        help: `\`${first.name.name}\` is declared on line ${first.span.line}; give each signal its own address`,
      });
    } else {
      byAddress.set(address.text, decl);
    }

    if (decl.safety && (!isInput || !isBool)) {
      const what = isInput ? "a real input" : "an output";
      ctx.error("T0306", decl.safety, {
        message: `\`safety\` applies only to bool inputs, but \`${name.name}\` is ${what}`,
        messageJa: `\`safety\` は bool 型の入力にのみ指定できますが、\`${name.name}\` は${isInput ? " real 型の入力" : "出力"}です`,
        label: "not allowed here",
        help: "mark E-stop and guard-door inputs as `safety`; outputs are made safe by `outputs safe` in handlers",
      });
    }
  }
}

function checkWrites(ctx: CheckContext): void {
  for (const state of ctx.station.sequence.states) {
    for (const s of state.statements) {
      if (s.kind !== "OutputOn") continue;
      const signal = ctx.signal(s.output);
      if (signal?.direction === "input") {
        ctx.error("T0304", s.output.span, {
          message: `\`${signal.name}\` is an input and cannot be switched on`,
          messageJa: `\`${signal.name}\` は入力のためONにできません`,
          label: "input",
          help: "only outputs can be switched on; inputs are read from sensors",
        });
      }
    }
  }
  for (const i of ctx.station.interlocks) {
    if (i.kind !== "RequiresInterlock") continue;
    const target = ctx.values.get(i.output.name);
    if (target && (target.kind === "device" || target.direction === "input")) {
      const what = target.kind === "device" ? "a device" : "an input";
      ctx.error("T0304", i.output.span, {
        message: `\`interlock … requires\` limits an output, but \`${target.name}\` is ${what}`,
        messageJa: `\`interlock … requires\` は出力を制限しますが、\`${target.name}\` は${target.kind === "device" ? "デバイス" : "入力"}です`,
        label: "not an output",
        help: "for a condition on inputs, use `interlock never (…)` or `interlock <cond> else fault <CODE>`",
      });
    }
  }
}

function checkSafetyUse(ctx: CheckContext): void {
  for (const site of conditionSites(ctx.station)) {
    if (site.where !== "state") continue;
    walkExpr(site.expr, (e) => {
      if (e.kind !== "NameRef") return;
      const signal = ctx.signal(e.name);
      if (!signal?.safety) return;
      ctx.error("T0305", e.span, {
        message: `safety signal \`${signal.name}\` is used in sequence logic`,
        messageJa: `安全信号 \`${signal.name}\` がシーケンスのロジックで使われています`,
        label: "safety signal",
        help: `keep the stop path independent of the sequence: handle it in \`on not ${signal.name} { outputs safe; -> Stopped }\``,
      });
    });
  }
}
