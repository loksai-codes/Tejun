// State-graph IR. Built only from a program that checked clean. The ST code
// generator and the runtime interpreter both read this, so the simulator
// behaves exactly like the generated PLC code.
//
// Meaning of a state:
//   - every output in `outputs`, plus the step's `drive` output, is ON for the
//     whole time the machine is in the state; every other output is OFF
//   - the step (if any) runs first: a device action waits for its `done`
//     sensor, a hold waits for its time
//   - then the transitions are tried top to bottom; the first true one is taken
//   - a timeout raises its fault when its time runs out first

import type * as A from "./ast.js";
import { DEVICE_KINDS, POSITION_DEBOUNCE_MS, POSITION_MISMATCH } from "./device-kinds.js";
import type { Span } from "./source.js";

export interface StationIR {
  name: string;
  label: string | undefined;
  signals: SignalIR[];
  devices: DeviceIR[];
  interlocks: InterlockIR[];
  /** The first state of the sequence. */
  initialState: string;
  states: StateIR[];
  /**
   * Fault codes in order of first appearance; fault number = index + 1. The
   * built-in POSITION_MISMATCH comes last, so it never renumbers the others.
   */
  faults: string[];
  handlers: HandlersIR;
  /** Runtime check that devices' sensors agree with their tracked positions; present when the station has devices. */
  positionCheck: PositionCheckIR | undefined;
}

export interface PositionCheckIR {
  fault: string;
  debounceMs: number;
}

export interface SignalIR {
  name: string;
  direction: "input" | "output";
  type: "bool" | "real";
  unit: string | undefined;
  address: string;
  label: string | undefined;
  safety: boolean;
  range: { min: number; max: number } | undefined;
}

export interface DeviceIR {
  name: string;
  kind: string;
  /** Parameter name -> signal name, e.g. { extend: "clamp_out", at_ext: "clamp_ext_ls" }. */
  wiring: Record<string, string>;
  /** Position name -> the input that confirms it, e.g. { extended: "clamp_ext_ls", retracted: "clamp_ret_ls" }. */
  sensors: Record<string, string>;
}

export type InterlockIR =
  | { kind: "never"; condition: ExprIR; span: Span }
  | { kind: "requires"; output: string; condition: ExprIR; span: Span }
  | { kind: "condition"; condition: ExprIR; fault: string; span: Span };

export interface StateIR {
  name: string;
  /** Outputs switched on directly in this state, in declaration order. */
  outputs: string[];
  step: StepIR | undefined;
  transitions: TransitionIR[];
  span: Span;
}

export type StepIR =
  | {
      kind: "device";
      device: string;
      action: string;
      /** Output that is ON for the whole state. */
      drive: string;
      /** Input that confirms the action finished. */
      done: string;
      timeout: TimeoutIR;
      span: Span;
    }
  | { kind: "hold"; ms: number; span: Span };

export interface TransitionIR {
  /** Undefined for a bare `-> State`. */
  condition: ExprIR | undefined;
  target: string;
  /** Undefined for a branch (a `when` followed by a default transition). */
  timeout: TimeoutIR | undefined;
  span: Span;
}

export type TimeoutIR = { kind: "within"; ms: number; fault: string } | { kind: "forever" };

export interface HandlersIR {
  /** Target of `on fault`, if present. */
  onFault: string | undefined;
  /** `on <condition>` handlers, e.g. the E-stop handler. */
  conditions: { condition: ExprIR; target: string }[];
}

export type ExprIR =
  | { kind: "signal"; name: string }
  | { kind: "device_state"; device: string; state: string; sensor: string }
  | { kind: "number"; value: number; unit: string | undefined }
  | { kind: "not"; operand: ExprIR }
  | { kind: "and" | "or"; left: ExprIR; right: ExprIR }
  | { kind: "compare"; op: A.CompareOp; left: ExprIR; right: ExprIR };

/** Render an IR expression in Tejun syntax, e.g. `press_force < 40 kN`. */
export function formatExpr(e: ExprIR): string {
  const operand = (x: ExprIR) => (x.kind === "and" || x.kind === "or" || x.kind === "compare" ? `(${formatExpr(x)})` : formatExpr(x));
  switch (e.kind) {
    case "signal":
      return e.name;
    case "device_state":
      return `${e.device}.${e.state}`;
    case "number":
      return e.unit ? `${e.value} ${e.unit}` : String(e.value);
    case "not":
      return `not ${operand(e.operand)}`;
    case "and":
    case "or":
      return `${operand(e.left)} ${e.kind} ${operand(e.right)}`;
    case "compare":
      return `${operand(e.left)} ${e.op} ${operand(e.right)}`;
  }
}

/** All outputs ON while the machine is in `state`. */
export function outputsOn(state: StateIR): string[] {
  return state.step?.kind === "device" ? [...state.outputs, state.step.drive] : [...state.outputs];
}

/**
 * Build the IR. The program must have checked clean: this function assumes
 * every name resolves and every device is fully wired.
 */
export function buildIR(program: A.Program): StationIR {
  const st = program.station;
  const devices = new Map(st.devices.map((d) => [d.name.name, d]));
  const outputOrder = new Map(st.io.decls.map((d, i) => [d.name.name, i]));

  const wiringOf = (device: A.DeviceDecl): Record<string, string> =>
    Object.fromEntries(device.args.map((a) => [a.param.name, a.signal.name]));

  const expr = (e: A.Expr): ExprIR => {
    switch (e.kind) {
      case "NameRef":
        return { kind: "signal", name: e.name.name };
      case "MemberRef": {
        const device = devices.get(e.object.name)!;
        const kind = DEVICE_KINDS.get(device.deviceKind.name)!;
        const param = kind.states[e.member.name]!;
        return { kind: "device_state", device: device.name.name, state: e.member.name, sensor: wiringOf(device)[param]! };
      }
      case "Quantity":
        return { kind: "number", value: e.value.value, unit: e.unit?.name };
      case "NotExpr":
        return { kind: "not", operand: expr(e.operand) };
      case "LogicalExpr":
        return { kind: e.op, left: expr(e.left), right: expr(e.right) };
      case "CompareExpr":
        return { kind: "compare", op: e.op, left: expr(e.left), right: expr(e.right) };
    }
  };

  const faults: { name: string; at: number }[] = [];
  const timeout = (t: A.Timeout): TimeoutIR => {
    if (t.kind === "ForeverTimeout") return { kind: "forever" };
    faults.push({ name: t.fault.name, at: t.fault.span.start });
    return { kind: "within", ms: toMs(t.duration), fault: t.fault.name };
  };

  const interlocks: InterlockIR[] = st.interlocks.map((i) => {
    switch (i.kind) {
      case "NeverInterlock":
        return { kind: "never", condition: expr(i.condition), span: i.span };
      case "RequiresInterlock":
        return { kind: "requires", output: i.output.name, condition: expr(i.condition), span: i.span };
      case "ConditionInterlock":
        faults.push({ name: i.fault.name, at: i.fault.span.start });
        return { kind: "condition", condition: expr(i.condition), fault: i.fault.name, span: i.span };
    }
  });

  const states: StateIR[] = st.sequence.states.map((state) => {
    const outputs: string[] = [];
    let step: StepIR | undefined;
    const transitions: TransitionIR[] = [];
    for (const s of state.statements) {
      switch (s.kind) {
        case "OutputOn":
          if (!outputs.includes(s.output.name)) outputs.push(s.output.name);
          break;
        case "DeviceAction": {
          const device = devices.get(s.device.name)!;
          const action = DEVICE_KINDS.get(device.deviceKind.name)!.actions[s.action.name]!;
          const wiring = wiringOf(device);
          step = {
            kind: "device",
            device: s.device.name,
            action: s.action.name,
            drive: wiring[action.drive]!,
            done: wiring[action.done]!,
            timeout: timeout(s.timeout!),
            span: s.span,
          };
          break;
        }
        case "Hold":
          step = { kind: "hold", ms: toMs(s.duration), span: s.span };
          break;
        case "When":
          transitions.push({
            condition: expr(s.condition),
            target: s.target.name,
            timeout: s.timeout ? timeout(s.timeout) : undefined,
            span: s.span,
          });
          break;
        case "Goto":
          transitions.push({ condition: undefined, target: s.target.name, timeout: undefined, span: s.span });
          break;
      }
    }
    outputs.sort((a, b) => outputOrder.get(a)! - outputOrder.get(b)!);
    return { name: state.name.name, outputs, step, transitions, span: state.span };
  });

  const handlers: HandlersIR = { onFault: undefined, conditions: [] };
  for (const h of st.handlers) {
    if (h.trigger.kind === "FaultTrigger") handlers.onFault = h.target.name;
    else handlers.conditions.push({ condition: expr(h.trigger), target: h.target.name });
  }

  return {
    name: st.name.name,
    label: st.label?.value,
    signals: st.io.decls.map((d) => ({
      name: d.name.name,
      direction: d.direction,
      type: d.type.kind === "BoolType" ? "bool" : "real",
      unit: d.type.kind === "RealType" ? d.type.unit?.name : undefined,
      address: d.address.text,
      label: d.label?.value,
      safety: d.safety !== undefined,
      range: d.range ? { min: d.range.min.value, max: d.range.max.value } : undefined,
    })),
    devices: st.devices.map((d) => {
      const wiring = wiringOf(d);
      const kind = DEVICE_KINDS.get(d.deviceKind.name)!;
      const sensors = Object.fromEntries(Object.entries(kind.states).map(([pos, param]) => [pos, wiring[param]!]));
      return { name: d.name.name, kind: d.deviceKind.name, wiring, sensors };
    }),
    interlocks,
    initialState: st.sequence.states[0]!.name.name,
    states,
    faults: [
      ...new Set(faults.sort((a, b) => a.at - b.at).map((f) => f.name)),
      ...(st.devices.length > 0 ? [POSITION_MISMATCH] : []),
    ],
    handlers,
    positionCheck: st.devices.length > 0 ? { fault: POSITION_MISMATCH, debounceMs: POSITION_DEBOUNCE_MS } : undefined,
  };
}

function toMs(d: A.Duration): number {
  return Math.round(d.unit.name === "s" ? d.value.value * 1000 : d.value.value);
}
