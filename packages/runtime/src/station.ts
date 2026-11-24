// Scan-cycle interpreter over the state-graph IR.
//
// It follows exactly the scan order of the generated Structured Text
// (packages/compiler/src/codegen/st.ts), so the simulator behaves like the
// PLC code. tests/equivalence.test.ts runs both side by side to prove it.
//
//   1. motors confirmed stopped, runtime monitors, the device check and
//      E-stop handlers (may stop the machine)
//   2. the current state: its step, or once the step is done its transitions
//   3. state entry for a new state: reset the step and timer, mark devices
//      moving, and start stopping the motors it does not run
//   4. every output assigned from the final state of the scan
//
// After the outputs are written, `never` and `requires` interlocks are
// re-checked. The proof rules violations out, so a report means a Tejun bug;
// reports never change behaviour.

import {
  departedStates,
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
  | { kind: "wait"; ms: number }
  | {
      kind: "mismatch";
      device: string;
      /** "position" (Cylinder) or "state" (Motor). */
      tracked: string;
      /** The tracked state: a device state name, "unknown", "moving", "moving from <state>", or e.g. "stopping". */
      state: string;
      /** The device's sensors as read in the faulting scan. */
      sensors: Readonly<Record<string, boolean>>;
      ms: number;
    };

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
  /** Device name -> its position when its current move started (for the position check). */
  private readonly from: Record<string, string>;
  /** Device name -> debounce timer of its position check. */
  private readonly mismatchTimers: Map<string, Ton>;

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
    this.mismatchTimers = new Map(ir.deviceCheck ? ir.devices.map((d) => [d.name, new Ton()]) : []);
    this.from = Object.fromEntries(ir.devices.map((d) => [d.name, UNKNOWN]));
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

    // 1. Releases, runtime monitors, the device check and E-stop.
    if (this.state !== STOPPED) {
      this.confirmReleases(inputs);
      for (const i of this.ir.interlocks) {
        if (i.kind === "condition" && this.fault === undefined && !this.truth(i.condition, inputs)) {
          this.raise(i.fault, { kind: "monitor", condition: formatExpr(i.condition) }, events);
        }
      }
      this.checkDevices(inputs, nowMs, events);
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
      const driven = entered?.step?.kind === "device" ? entered.step.device : undefined;
      if (driven) {
        this.from[driven] = this.pos[driven]!;
        this.pos[driven] = MOVING;
      }
      // A device that acts only while driven is released by every state that
      // does not drive it, including Stopped.
      for (const d of this.ir.devices) {
        if (!d.release || d.name === driven) continue;
        const p = this.pos[d.name]!;
        if (p === MOVING || (p in d.states && p !== d.release.state)) this.pos[d.name] = d.release.via;
      }
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

  /** A releasing (or unknown) device whose sensor confirms its release state reaches it. Same as codegen/st.ts. */
  private confirmReleases(inputs: Inputs): void {
    for (const d of this.ir.devices) {
      if (!d.release) continue;
      const p = this.pos[d.name];
      const { sensor, value } = d.states[d.release.state]!;
      if ((p === UNKNOWN || p === d.release.via) && (inputs[sensor] === true) === value) this.pos[d.name] = d.release.state;
    }
  }

  /**
   * Per device, a mismatch is any of: two states confirmed by different
   * sensors both hold; the device is tracked in a state its sensor
   * contradicts; or it is moving away from a state that still holds.
   * Lasting `debounceMs` raises the device's mismatch fault. Same expression
   * and order as codegen/st.ts.
   */
  private checkDevices(inputs: Inputs, nowMs: number, events: ScanEvent[]): void {
    const check = this.ir.deviceCheck;
    if (!check) return;
    for (const d of this.ir.devices) {
      const states = Object.keys(d.states);
      const holds = (s: string) => (inputs[d.states[s]!.sensor] === true) === d.states[s]!.value;
      const pos = this.pos[d.name]!;
      const both = states.some((a, i) =>
        states.slice(i + 1).some((b) => d.states[a]!.sensor !== d.states[b]!.sensor && holds(a) && holds(b)),
      );
      const contradicted = states.some((s) => pos === s && !holds(s));
      const notLeaving = pos === MOVING && departedStates(d).some((s) => this.from[d.name] === s && holds(s));
      const timer = this.mismatchTimers.get(d.name)!;
      timer.call(nowMs, both || contradicted || notLeaving, check.debounceMs);
      if (this.fault === undefined && timer.q) {
        const sensorNames = [...new Set(states.map((s) => d.states[s]!.sensor))];
        const sensors = Object.fromEntries(sensorNames.map((s) => [s, inputs[s] === true]));
        const state =
          pos === MOVING && departedStates(d).includes(this.from[d.name]!) ? `moving from ${this.from[d.name]}` : pos;
        this.raise(d.mismatchFault, { kind: "mismatch", device: d.name, tracked: d.tracked, state, sensors, ms: check.debounceMs }, events);
      }
    }
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
      this.pos[step.device] = step.target;
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
