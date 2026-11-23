// Scan-cycle interpreter over the state-graph IR.
//
// It follows exactly the scan order of the generated Structured Text
// (packages/compiler/src/codegen/st.ts), so the simulator behaves like the
// PLC code. tests/equivalence.test.ts runs both side by side to prove it.
//
//   1. runtime monitors and E-stop handlers (may stop the machine)
//   2. the current state: its step, or once the step is done its transitions
//   3. state entry for a new state: reset the step and timer, mark devices moving
//   4. every output assigned from the final state of the scan
//
// After the outputs are written, `never` and `requires` interlocks are
// re-checked. The proof rules violations out, so a report means a Tejun bug;
// reports never change behaviour.

import {
  DEVICE_KINDS,
  formatExpr,
  outputsOn,
  type ExprIR,
  type InterlockIR,
  type StateIR,
  type StationIR,
  type TransitionIR,
} from "@tejun/compiler";
import { Ton } from "./timer.js";

export const STOPPED = "Stopped";
export const UNKNOWN = "unknown";
export const MOVING = "moving";

/** Input values for one scan: bool inputs, and real inputs in their declared unit. */
export type Inputs = Readonly<Record<string, boolean | number>>;

export type FaultCause =
  | { kind: "monitor"; condition: string }
  | { kind: "step"; sensor: string; ms: number }
  | { kind: "wait"; ms: number };

/** Something that happened during one scan. */
export type ScanEvent =
  | { kind: "fault"; fault: string; number: number; cause: FaultCause }
  | { kind: "stopped"; by: "handler"; condition: string }
  | { kind: "transition"; from: string; to: string }
  | { kind: "violation"; interlock: string };

export interface ScanResult {
  events: ScanEvent[];
  state: string;
  fault: string | undefined;
  outputs: Readonly<Record<string, boolean>>;
}

export class StationRuntime {
  readonly ir: StationIR;
  private readonly states: Map<string, StateIR>;
  private readonly boolOutputs: string[];
  state: string;
  fault: string | undefined;
  /** Device name -> position: a device state name, "moving" or "unknown". */
  readonly pos: Record<string, string>;
  /** Output values as last written (what a condition reading an output sees). */
  outputs: Record<string, boolean>;
  private lastState: string;
  private stepDone = false;
  private readonly timer = new Ton();

  constructor(ir: StationIR) {
    this.ir = ir;
    this.states = new Map(ir.states.map((s) => [s.name, s]));
    this.boolOutputs = ir.signals.filter((s) => s.direction === "output" && s.type === "bool").map((s) => s.name);
    this.state = ir.initialState;
    this.lastState = ir.initialState; // the initial state counts as already entered
    this.fault = undefined;
    const initial = this.states.get(ir.initialState)!;
    this.pos = Object.fromEntries(
      ir.devices.map((d) => [d.name, initial.step?.kind === "device" && initial.step.device === d.name ? MOVING : UNKNOWN]),
    );
    this.outputs = Object.fromEntries(this.boolOutputs.map((o) => [o, false]));
  }

  /** Fault number as in the generated code: 0 none, else 1-based position in `ir.faults`. */
  faultNumber(): number {
    return this.fault === undefined ? 0 : this.ir.faults.indexOf(this.fault) + 1;
  }

  /** State number as in the generated code: 0 Stopped, else 1-based position in `ir.states`. */
  stateNumber(): number {
    return this.state === STOPPED ? 0 : this.ir.states.findIndex((s) => s.name === this.state) + 1;
  }

  scan(inputs: Inputs, nowMs: number): ScanResult {
    const events: ScanEvent[] = [];
    const from = this.state;
    const env = { inputs, nowMs, events };

    // 1. Runtime monitors and E-stop.
    if (this.state !== STOPPED) {
      for (const i of this.ir.interlocks) {
        if (i.kind === "condition" && this.fault === undefined && !this.truth(i.condition, inputs)) {
          this.raise(i.fault, { kind: "monitor", condition: formatExpr(i.condition) }, events);
        }
      }
      for (const h of this.ir.handlers.conditions) {
        if (this.truth(h.condition, inputs)) {
          if (this.fault === undefined && this.state !== STOPPED) {
            events.push({ kind: "stopped", by: "handler", condition: formatExpr(h.condition) });
          }
          this.state = h.target;
        }
      }
    }
    if (this.fault !== undefined) this.state = STOPPED;

    // 2. The current state.
    const state = this.states.get(this.state);
    if (state) this.runState(state, env);
    if (this.fault !== undefined) this.state = STOPPED;

    // 3. State entry.
    if (this.state !== this.lastState) {
      this.lastState = this.state;
      this.stepDone = false;
      this.timer.call(nowMs, false);
      const entered = this.states.get(this.state);
      if (entered?.step?.kind === "device") this.pos[entered.step.device] = MOVING;
    }

    // 4. Outputs.
    const final = this.states.get(this.state);
    const on = new Set(final ? outputsOn(final) : []);
    this.outputs = Object.fromEntries(this.boolOutputs.map((o) => [o, on.has(o)]));

    if (this.state !== from) events.push({ kind: "transition", from, to: this.state });
    for (const i of this.ir.interlocks) {
      if (this.violated(i, inputs)) events.push({ kind: "violation", interlock: describeInterlock(i) });
    }
    return { events, state: this.state, fault: this.fault, outputs: this.outputs };
  }

  private runState(state: StateIR, env: { inputs: Inputs; nowMs: number; events: ScanEvent[] }): void {
    const { inputs, nowMs, events } = env;
    const step = state.step;
    if (!step || this.stepDone) {
      this.runTransitions(state.transitions, inputs, nowMs, events);
      return;
    }
    if (step.kind === "hold") {
      this.timer.call(nowMs, true, step.ms);
      if (this.timer.q) this.finishStep(nowMs);
      return;
    }
    if (step.timeout.kind === "within") this.timer.call(nowMs, true, step.timeout.ms);
    if (inputs[step.done] === true) {
      this.finishStep(nowMs);
      this.pos[step.device] = this.positionAfter(step.device, step.action);
    } else if (step.timeout.kind === "within" && this.timer.q) {
      this.raise(step.timeout.fault, { kind: "step", sensor: step.done, ms: step.timeout.ms }, events);
    }
  }

  private finishStep(nowMs: number): void {
    this.stepDone = true;
    this.timer.call(nowMs, false);
  }

  private runTransitions(transitions: TransitionIR[], inputs: Inputs, nowMs: number, events: ScanEvent[]): void {
    const timed = transitions.filter((t) => t.timeout?.kind === "within");
    const longest = Math.max(0, ...timed.map((t) => (t.timeout?.kind === "within" ? t.timeout.ms : 0)));
    if (timed.length > 0) this.timer.call(nowMs, true, longest);

    for (const t of transitions) {
      if (!t.condition || this.truth(t.condition, inputs)) {
        this.state = t.target;
        return;
      }
    }
    for (const t of timed) {
      if (t.timeout?.kind === "within" && this.timer.et >= t.timeout.ms) {
        this.raise(t.timeout.fault, { kind: "wait", ms: t.timeout.ms }, events);
        return;
      }
    }
  }

  private raise(fault: string, cause: FaultCause, events: ScanEvent[]): void {
    this.fault = fault;
    events.push({ kind: "fault", fault, number: this.ir.faults.indexOf(fault) + 1, cause });
  }

  private positionAfter(device: string, action: string): string {
    const kind = DEVICE_KINDS.get(this.ir.devices.find((d) => d.name === device)!.kind)!;
    const done = kind.actions[action]!.done;
    return Object.keys(kind.states).find((s) => kind.states[s] === done)!;
  }

  private violated(i: InterlockIR, inputs: Inputs): boolean {
    if (i.kind === "never") return this.truth(i.condition, inputs);
    if (i.kind === "requires") return this.outputs[i.output] === true && !this.truth(i.condition, inputs);
    return false;
  }

  private truth(e: ExprIR, inputs: Inputs): boolean {
    return Boolean(this.value(e, inputs));
  }

  private value(e: ExprIR, inputs: Inputs): boolean | number {
    switch (e.kind) {
      case "signal":
        return e.name in this.outputs ? this.outputs[e.name]! : (inputs[e.name] ?? false);
      case "device_state":
        return this.pos[e.device] === e.state;
      case "number":
        return e.value;
      case "not":
        return !this.truth(e.operand, inputs);
      case "and":
        return this.truth(e.left, inputs) && this.truth(e.right, inputs);
      case "or":
        return this.truth(e.left, inputs) || this.truth(e.right, inputs);
      case "compare": {
        const l = this.value(e.left, inputs);
        const r = this.value(e.right, inputs);
        switch (e.op) {
          case "==":
            return l === r;
          case "!=":
            return l !== r;
          case "<":
            return l < r;
          case "<=":
            return l <= r;
          case ">":
            return l > r;
          case ">=":
            return l >= r;
        }
      }
    }
  }
}

function describeInterlock(i: InterlockIR): string {
  if (i.kind === "never") return `never ${formatExpr(i.condition)}`;
  if (i.kind === "requires") return `${i.output} requires ${formatExpr(i.condition)}`;
  return `${formatExpr(i.condition)} else fault ${i.fault}`;
}
