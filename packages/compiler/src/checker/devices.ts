// T0401 unknown device kind, T0402 missing parameter, T0403 unknown or
// repeated parameter, T0404 parameter wired to the wrong kind of signal,
// T0405 unknown action or state, T0406 output driven from two places.

import type * as A from "../ast.js";
import { DEVICE_KINDS, type DeviceKind } from "../device-kinds.js";
import { closest } from "../suggest.js";
import { conditionSites, walkExpr, type CheckContext, type DeviceSymbol } from "./context.js";

interface Owner {
  device: DeviceSymbol;
  param: string;
}

export function checkDevices(ctx: CheckContext): void {
  /** Output signal name -> the device parameter that drives it. */
  const owners = new Map<string, Owner>();
  for (const decl of ctx.station.devices) {
    const device = ctx.device(decl.name);
    if (device?.decl === decl) checkDeclaration(ctx, device, owners);
  }
  checkStatements(ctx, owners);
  checkStateReferences(ctx);
}

function checkDeclaration(ctx: CheckContext, device: DeviceSymbol, owners: Map<string, Owner>): void {
  const { decl, deviceKind: kind } = device;
  if (!kind) {
    const suggestion = closest(decl.deviceKind.name, DEVICE_KINDS.keys());
    ctx.error("T0401", decl.deviceKind.span, {
      message: `unknown device kind \`${decl.deviceKind.name}\``,
      messageJa: `不明なデバイス種別 \`${decl.deviceKind.name}\``,
      label: "unknown device kind",
      help: suggestion
        ? `did you mean \`${suggestion}\`?`
        : `available device kinds: ${[...DEVICE_KINDS.keys()].join(", ")}`,
    });
    return;
  }

  const given = new Set<string>();
  /** Parameters an unknown name was probably meant to be; not reported as missing too. */
  const suggested = new Set<string>();

  for (const arg of decl.args) {
    const param = kind.params.find((p) => p.name === arg.param.name);
    if (!param) {
      const suggestion = closest(arg.param.name, kind.params.map((p) => p.name));
      if (suggestion) suggested.add(suggestion);
      ctx.error("T0403", arg.param.span, {
        message: `${kind.name} has no parameter \`${arg.param.name}\``,
        messageJa: `${kind.name} にパラメータ \`${arg.param.name}\` はありません`,
        label: "unknown parameter",
        help: suggestion
          ? `did you mean \`${suggestion}\`?`
          : `${kind.name} parameters: ${kind.params.map((p) => p.name).join(", ")}`,
      });
      continue;
    }
    if (given.has(param.name)) {
      ctx.error("T0403", arg.param.span, {
        message: `parameter \`${param.name}\` is given twice`,
        messageJa: `パラメータ \`${param.name}\` が2回指定されています`,
        label: "repeated parameter",
        help: "remove one of them",
      });
      continue;
    }
    given.add(param.name);

    const target = ctx.values.get(arg.signal.name);
    if (!target) continue; // reported by names.ts
    const dirJa = param.direction === "input" ? "入力" : "出力";
    if (target.kind === "device" || target.direction !== param.direction || target.type !== "bool") {
      const what =
        target.kind === "device"
          ? ["a device", "デバイス"]
          : target.type !== "bool"
            ? ["a real signal", "real 型の信号"]
            : target.direction === "input"
              ? ["an input", "入力"]
              : ["an output", "出力"];
      ctx.error("T0404", arg.signal.span, {
        message: `parameter \`${param.name}\` needs a bool ${param.direction}, but \`${target.name}\` is ${what[0]}`,
        messageJa: `パラメータ \`${param.name}\` には bool 型の${dirJa}が必要ですが、\`${target.name}\` は${what[1]}です`,
        label: `expected a bool ${param.direction}`,
        help: `\`${param.name}\` is ${param.description}`,
      });
      continue;
    }

    device.wiring.set(param.name, target);
    if (param.direction === "output") {
      const prev = owners.get(target.name);
      if (prev) {
        const where = prev.device === device ? `\`${prev.param}\` of this device` : `device \`${prev.device.name}\``;
        const whereJa = prev.device === device ? `このデバイスの \`${prev.param}\`` : `デバイス \`${prev.device.name}\``;
        ctx.error("T0406", arg.signal.span, {
          message: `output \`${target.name}\` is already driven by ${where}`,
          messageJa: `出力 \`${target.name}\` はすでに${whereJa}が駆動しています`,
          label: "driven twice",
          help: "each output must be driven from exactly one place; wire a separate output",
        });
      } else {
        owners.set(target.name, { device, param: param.name });
      }
    }
  }

  const missing = kind.params.filter((p) => !given.has(p.name) && !suggested.has(p.name));
  if (missing.length > 0) {
    const list = missing.map((p) => `\`${p.name}\``).join(", ");
    const noFeedback = missing.some((p) => p.direction === "input");
    const help =
      missing.map((p) => `\`${p.name}\` is ${p.description}`).join("; ") +
      (noFeedback ? "; without it Tejun cannot confirm that a move finished" : "");
    ctx.error("T0402", decl.name.span, {
      message: `device \`${decl.name.name}\` is missing ${missing.length === 1 ? "parameter" : "parameters"} ${list}`,
      messageJa: `デバイス \`${decl.name.name}\` にパラメータ ${list} がありません`,
      label: `missing ${list}`,
      help,
    });
  }
}

function checkStatements(ctx: CheckContext, owners: Map<string, Owner>): void {
  for (const state of ctx.station.sequence.states) {
    for (const s of state.statements) {
      if (s.kind === "DeviceAction") checkAction(ctx, s);
      if (s.kind === "OutputOn") {
        const owner = owners.get(s.output.name);
        if (!owner) continue;
        const kind = owner.device.deviceKind!;
        const action = Object.entries(kind.actions).find(([, a]) => a.drive === owner.param)?.[0];
        const name = owner.device.name;
        ctx.error("T0406", s.output.span, {
          message: `\`${s.output.name}\` is driven by device \`${name}\`; switching it directly drives it from two places (double coil)`,
          messageJa: `\`${s.output.name}\` はデバイス \`${name}\` が駆動しています。直接ONにすると2か所から駆動されます (二重コイル)`,
          label: `driven by \`${name}\``,
          help: action ? `use \`${name}.${action} within … else fault …\` instead` : "let the device drive it",
        });
      }
    }
  }
}

function checkAction(ctx: CheckContext, s: A.DeviceAction): void {
  const target = ctx.values.get(s.device.name);
  if (!target) return;
  if (target.kind === "signal") {
    ctx.error("T0103", s.device.span, {
      message: `\`${target.name}\` is a signal, not a device`,
      messageJa: `\`${target.name}\` は信号であり、デバイスではありません`,
      label: "not a device",
      help: target.direction === "output" ? `to switch an output, write \`${target.name} on\`` : "only devices have actions",
    });
    return;
  }
  const kind = target.deviceKind;
  if (!kind || s.action.name in kind.actions) return;
  ctx.error("T0405", s.action.span, {
    message: `${kind.name} has no action \`${s.action.name}\``,
    messageJa: `${kind.name} に動作 \`${s.action.name}\` はありません`,
    label: "unknown action",
    help: memberHelp(kind, s.action.name, "action"),
  });
}

function checkStateReferences(ctx: CheckContext): void {
  for (const site of conditionSites(ctx.station)) {
    walkExpr(site.expr, (e) => {
      if (e.kind !== "MemberRef") return;
      const kind = ctx.device(e.object)?.deviceKind;
      if (!kind || e.member.name in kind.states) return;
      ctx.error("T0405", e.member.span, {
        message: `${kind.name} has no state \`${e.member.name}\``,
        messageJa: `${kind.name} に状態 \`${e.member.name}\` はありません`,
        label: "unknown state",
        help: memberHelp(kind, e.member.name, "state"),
      });
    });
  }
}

/** Help for an unknown action or state, including action/state mix-ups. */
function memberHelp(kind: DeviceKind, name: string, want: "action" | "state"): string {
  const actions = Object.keys(kind.actions);
  const states = Object.keys(kind.states);
  if (want === "state" && name in kind.actions) {
    const done = kind.actions[name]!.done;
    const state = states.find((s) => kind.states[s] === done);
    if (state) return `\`${name}\` is an action; the state is \`${state}\``;
  }
  if (want === "action" && name in kind.states) {
    const sensor = kind.states[name];
    const action = actions.find((a) => kind.actions[a]!.done === sensor);
    if (action) return `\`${name}\` is a state; the action is \`${action}\``;
  }
  const options = want === "action" ? actions : states;
  const suggestion = closest(name, options);
  return suggestion
    ? `did you mean \`${suggestion}\`?`
    : `${kind.name} ${want}s: ${options.join(", ")}`;
}
