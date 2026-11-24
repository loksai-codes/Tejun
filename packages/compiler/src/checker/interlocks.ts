// T0203 interlock violated, T0210 station too large to prove.
//
// Runs on the IR of a program that checked clean. Explores every reachable
// configuration breadth-first, so the first violation found for an
// interlock has the shortest path. Model, per scan:
//   - every free input is true or false: bool inputs that the logic reads,
//     and each comparison on a real input (e.g. `press_force < 40 kN`)
//   - the state's timer is either done or not done
//   - device states are tracked, not read from sensors: a device is
//     "moving" while its action runs, takes the action's state when the
//     done sensor confirms it, and is "unknown" at startup. A device that
//     acts only while driven (Motor) is put in its release's `via` state
//     ("stopping") by every state that does not drive it, and reaches the
//     release state ("stopped") at the start of a scan whose sensor
//     confirms it; its sensor is always a free input
//   - E-stop handlers and runtime monitors (`<cond> else fault`) can stop
//     the machine; in Stopped every output is OFF
//   - outputs are written at the end of the scan, so an interlock is checked
//     against the state a scan ends in and the inputs that scan read
// `never` and `requires` interlocks are proved; `<cond> else fault`
// interlocks are runtime monitors and are not part of the proof.
//
// The device check (POSITION_MISMATCH, FEEDBACK_MISMATCH) is not modelled separately:
// all it can do is stop the machine, and every station has an E-stop handler
// whose input is free here, so "stop in any scan" is already explored. The
// check is what makes tracked positions trustworthy at runtime; see
// docs/model-assumptions.md.

import type * as A from "../ast.js";
import { DEVICE_KINDS } from "../device-kinds.js";
import type { Diagnostic } from "../diagnostics.js";
import { outputsOn, type ExprIR, type InterlockIR, type StateIR, type StationIR } from "../ir.js";
import type { SourceFile, Span } from "../source.js";
import { STOPPED, snippet } from "./context.js";

export const MAX_FREE_INPUTS = 10;

const UNKNOWN = "unknown";
const MOVING = "moving";

interface Config {
  state: string;
  /** "step" while the state's step runs; "wait" once it is done (or if there is none). */
  phase: "step" | "wait";
  /** Device name -> position: a device state name, "moving" or "unknown". */
  pos: Record<string, string>;
}

interface Node {
  config: Config;
  parent: Node | undefined;
}

/** Values of the free inputs for one scan, keyed by atom key. */
type Assignment = ReadonlyMap<string, boolean>;

export function checkInterlocks(ir: StationIR, program: A.Program, source: SourceFile): Diagnostic[] {
  const model = new Model(ir);
  if (model.atoms.length > MAX_FREE_INPUTS) return [tooLarge(ir, program, model.atoms)];

  const proved = ir.interlocks
    .map((interlock, index) => ({ interlock, ast: program.station.interlocks[index]! }))
    .filter((x) => x.interlock.kind !== "condition");
  if (proved.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  const reported = new Set<InterlockIR>();
  const assignments = model.assignments();
  const start: Node = { config: model.enter(ir.initialState, initialPositions(ir)), parent: undefined };
  const seen = new Set([key(start.config)]);
  const queue: Node[] = [start];

  // Outputs are written at the end of each scan from the state the scan
  // ended in, using the inputs it read. So each interlock is checked against
  // the configuration *after* a scan, together with that scan's inputs.
  for (let node = queue.shift(); node; node = queue.shift()) {
    for (const a of assignments) {
      for (const timerDone of [false, true]) {
        const next: Node = { config: model.step(node.config, a, timerDone), parent: node };
        for (const { interlock, ast } of proved) {
          if (reported.has(interlock) || !model.violates(interlock, next.config, a)) continue;
          reported.add(interlock);
          diagnostics.push(violation(ir, program, source, model, interlock, ast, next));
        }
        if (reported.size === proved.length) return diagnostics;
        const k = key(next.config);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(next);
      }
    }
  }
  return diagnostics;
}

class Model {
  readonly ir: StationIR;
  readonly states: Map<string, StateIR>;
  /** Free inputs: bool input names and keys of comparisons on real inputs. */
  readonly atoms: string[];
  private readonly inputs: Set<string>;
  private readonly outputs: Set<string>;
  private readonly realInputs: Set<string>;

  constructor(ir: StationIR) {
    this.ir = ir;
    this.states = new Map(ir.states.map((s) => [s.name, s]));
    this.inputs = new Set(ir.signals.filter((s) => s.direction === "input" && s.type === "bool").map((s) => s.name));
    this.realInputs = new Set(ir.signals.filter((s) => s.direction === "input" && s.type === "real").map((s) => s.name));
    this.outputs = new Set(ir.signals.filter((s) => s.direction === "output").map((s) => s.name));
    this.atoms = this.collectAtoms();
  }

  private collectAtoms(): string[] {
    const atoms = new Set<string>();
    const visit = (e: ExprIR): void => {
      switch (e.kind) {
        case "signal":
          if (this.inputs.has(e.name)) atoms.add(e.name);
          return;
        case "compare":
          if (this.mentionsRealInput(e)) atoms.add(atomKey(e));
          else {
            visit(e.left);
            visit(e.right);
          }
          return;
        case "not":
          visit(e.operand);
          return;
        case "and":
        case "or":
          visit(e.left);
          visit(e.right);
          return;
        case "device_state":
        case "number":
          return;
      }
    };
    for (const i of this.ir.interlocks) visit(i.condition);
    for (const h of this.ir.handlers.conditions) visit(h.condition);
    for (const s of this.ir.states) {
      if (s.step?.kind === "device") atoms.add(s.step.done);
      for (const t of s.transitions) if (t.condition) visit(t.condition);
    }
    for (const d of this.ir.devices) if (d.release) atoms.add(d.states[d.release.state]!.sensor);
    return [...atoms];
  }

  private mentionsRealInput(e: ExprIR): boolean {
    switch (e.kind) {
      case "signal":
        return this.realInputs.has(e.name);
      case "compare":
      case "and":
      case "or":
        return this.mentionsRealInput(e.left) || this.mentionsRealInput(e.right);
      case "not":
        return this.mentionsRealInput(e.operand);
      default:
        return false;
    }
  }

  /** Every combination of free-input values. */
  assignments(): Assignment[] {
    const out: Assignment[] = [];
    for (let mask = 0; mask < 1 << this.atoms.length; mask++) {
      out.push(new Map(this.atoms.map((atom, i) => [atom, (mask & (1 << i)) !== 0])));
    }
    return out;
  }

  /** The configuration on entering a state. */
  enter(name: string, pos: Record<string, string>): Config {
    const state = this.states.get(name);
    const driven = state?.step?.kind === "device" ? state.step.device : undefined;
    const released = this.release(pos, driven);
    if (!state) return { state: STOPPED, phase: "wait", pos: released };
    if (!state.step) return { state: name, phase: "wait", pos: released };
    if (state.step.kind === "device") return { state: name, phase: "step", pos: { ...released, [state.step.device]: MOVING } };
    return { state: name, phase: "step", pos: released };
  }

  /** Devices that act only while driven, and are not driven by the state being entered, start to release. */
  private release(pos: Record<string, string>, driven: string | undefined): Record<string, string> {
    const out = { ...pos };
    for (const d of this.ir.devices) {
      if (!d.release || d.name === driven) continue;
      const p = out[d.name]!;
      if (p === MOVING || (p in d.states && p !== d.release.state)) out[d.name] = d.release.via;
    }
    return out;
  }

  /** At the start of a scan: a releasing (or unknown) device whose sensor confirms its release state reaches it. */
  private confirmReleases(c: Config, a: Assignment): Config {
    let pos = c.pos;
    for (const d of this.ir.devices) {
      if (!d.release) continue;
      const p = pos[d.name];
      const { sensor, value } = d.states[d.release.state]!;
      if ((p === UNKNOWN || p === d.release.via) && a.get(sensor) === value) pos = { ...pos, [d.name]: d.release.state };
    }
    return pos === c.pos ? c : { ...c, pos };
  }

  /** One scan. Mirrors the order of the generated Structured Text. */
  step(start: Config, a: Assignment, timerDone: boolean): Config {
    if (start.state === STOPPED) return start;
    const c = this.confirmReleases(start, a);
    const stopped: Config = this.enter(STOPPED, c.pos);
    for (const i of this.ir.interlocks) {
      if (i.kind === "condition" && !this.truth(i.condition, c, a)) return stopped;
    }
    for (const h of this.ir.handlers.conditions) {
      if (this.truth(h.condition, c, a)) return stopped;
    }

    const state = this.states.get(c.state)!;
    if (c.phase === "step" && state.step) {
      const step = state.step;
      if (step.kind === "hold") return timerDone ? { ...c, phase: "wait" } : c;
      if (a.get(step.done)) return { ...c, phase: "wait", pos: { ...c.pos, [step.device]: step.target } };
      return timerDone && step.timeout.kind === "within" ? stopped : c;
    }

    for (const t of state.transitions) {
      if (!t.condition || this.truth(t.condition, c, a)) return this.enter(t.target, c.pos);
    }
    return timerDone && state.transitions.some((t) => t.timeout?.kind === "within") ? stopped : c;
  }

  /** Whether an interlock is violated in this configuration for these inputs. */
  violates(i: InterlockIR, c: Config, a: Assignment): boolean {
    if (i.kind === "never") return this.truth(i.condition, c, a);
    if (i.kind === "requires") return this.outputsOn(c).has(i.output) && !this.truth(i.condition, c, a);
    return false;
  }

  outputsOn(c: Config): Set<string> {
    const state = this.states.get(c.state);
    return new Set(state ? outputsOn(state) : []);
  }

  truth(e: ExprIR, c: Config, a: Assignment): boolean {
    return Boolean(this.value(e, c, a));
  }

  private value(e: ExprIR, c: Config, a: Assignment): boolean | number {
    switch (e.kind) {
      case "signal":
        if (this.outputs.has(e.name)) return this.outputsOn(c).has(e.name);
        return a.get(e.name) ?? false;
      case "device_state":
        return c.pos[e.device] === e.state;
      case "number":
        return e.value;
      case "not":
        return !this.truth(e.operand, c, a);
      case "and":
        return this.truth(e.left, c, a) && this.truth(e.right, c, a);
      case "or":
        return this.truth(e.left, c, a) || this.truth(e.right, c, a);
      case "compare": {
        const atom = a.get(atomKey(e));
        if (atom !== undefined) return atom;
        const l = this.value(e.left, c, a);
        const r = this.value(e.right, c, a);
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

function initialPositions(ir: StationIR): Record<string, string> {
  return Object.fromEntries(ir.devices.map((d) => [d.name, UNKNOWN]));
}

function key(c: Config): string {
  return `${c.state}|${c.phase}|${Object.entries(c.pos).map(([d, p]) => `${d}=${p}`).join(",")}`;
}

function atomKey(e: ExprIR): string {
  return JSON.stringify(e);
}

function pathOf(node: Node): string[] {
  const states: string[] = [];
  for (let n: Node | undefined = node; n; n = n.parent) {
    if (states[0] !== n.config.state) states.unshift(n.config.state);
  }
  return states;
}

function violation(
  ir: StationIR,
  program: A.Program,
  source: SourceFile,
  model: Model,
  interlock: InterlockIR,
  ast: A.Interlock,
  node: Node,
): Diagnostic {
  const c = node.config;
  const condition = snippet(source, ast.condition.span, 60);
  const interlockText = snippet(source, ast.span, 70);
  const path = pathOf(node);
  const atStartup = path.length === 1;
  const notes = [
    `path: ${path.join(" -> ")}${atStartup ? " (at startup)" : ""}`,
    `interlock: \`${interlockText}\` (line ${ast.span.line})`,
  ];

  // Point at whatever turns the offending output on in this state.
  const on = model.outputsOn(c);
  const output =
    interlock.kind === "requires" ? interlock.output : outputsIn(interlock.condition).find((o) => on.has(o));
  const span = (output ? outputSpan(program, model, c.state, output) : undefined) ?? ast.span;

  // For `requires`: a device whose position makes the condition fail.
  const device =
    interlock.kind === "requires"
      ? deviceStates(interlock.condition).find((d) => c.pos[d.device] !== d.state)
      : undefined;
  const onInCondition = [...new Set(outputsIn(interlock.condition))].filter((o) => on.has(o));
  const deviceIR = device ? ir.devices.find((d) => d.name === device.device) : undefined;
  const releasing = deviceIR?.release && deviceIR.release.state === device?.state ? deviceIR.release : undefined;
  let help: string;
  if (device && releasing && (c.pos[device.device] === releasing.via || c.pos[device.device] === UNKNOWN)) {
    const what = c.pos[device.device] === UNKNOWN ? `is not confirmed ${releasing.state}` : `may still be ${releasing.via}`;
    const wait = `Wait${device.device[0]!.toUpperCase()}${device.device.slice(1)}`;
    help = `\`${device.device}\` ${what} in \`${c.state}\`; wait for \`${device.device}.${releasing.state}\` first, e.g. \`state ${wait} { when ${device.device}.${releasing.state} within 2 s else fault ${device.device.toUpperCase()}_NO_STOP -> ${c.state} }\``;
  } else if (device && c.pos[device.device] === UNKNOWN) {
    const action = homeAction(ir, device.device, device.state);
    help = `the position of \`${device.device}\` is unknown at startup; confirm it first, e.g. \`state Home { ${device.device}.${action} within 2 s else fault HOME_TIMEOUT; -> ${ir.initialState} }\``;
  } else if (device && c.pos[device.device] === MOVING) {
    help = `\`${device.device}\` is still moving in \`${c.state}\`; switch \`${output ?? "the output"}\` on only after the move is confirmed`;
  } else if (interlock.kind === "requires") {
    help = `switch \`${interlock.output}\` off in \`${c.state}\`, or make sure \`${condition}\` holds before entering it`;
  } else if (onInCondition.length >= 2) {
    const list = onInCondition.map((o) => `\`${o}\``).join(" and ");
    help = `${list} are both ON in \`${c.state}\`; switch one of them off there`;
  } else if (onInCondition.length === 1) {
    help = `\`${onInCondition[0]}\` is ON in \`${c.state}\`; switch it off there, or make sure \`${condition}\` cannot hold`;
  } else {
    help = `make sure \`${condition}\` cannot hold in \`${c.state}\``;
  }

  if (interlock.kind === "requires") {
    return {
      code: "T0203",
      severity: "error",
      message: `interlock violated: \`${interlock.output}\` can be ON while \`${condition}\` is false`,
      messageJa: `インターロック違反: \`${condition}\` が偽のときに \`${interlock.output}\` がONになる可能性があります`,
      span,
      label: `\`${interlock.output}\` is ON here in \`${c.state}\``,
      notes,
      help,
    };
  }
  return {
    code: "T0203",
    severity: "error",
    message: `interlock violated: \`${condition}\` can become true`,
    messageJa: `インターロック違反: \`${condition}\` が真になる可能性があります`,
    span,
    label: `can happen here in \`${c.state}\``,
    notes,
    help,
  };
}

/** The statement that switches `output` on in `state`: `x on`, or the step that drives it. */
function outputSpan(program: A.Program, model: Model, state: string, output: string): Span | undefined {
  const ir = model.states.get(state);
  if (ir?.step?.kind === "device" && ir.step.drive === output) return ir.step.span;
  const ast = program.station.sequence.states.find((s) => s.name.name === state);
  return ast?.statements.find((s) => s.kind === "OutputOn" && s.output.name === output)?.span;
}

function outputsIn(e: ExprIR): string[] {
  switch (e.kind) {
    case "signal":
      return [e.name];
    case "not":
      return outputsIn(e.operand);
    case "and":
    case "or":
    case "compare":
      return [...outputsIn(e.left), ...outputsIn(e.right)];
    default:
      return [];
  }
}

function deviceStates(e: ExprIR): { device: string; state: string }[] {
  switch (e.kind) {
    case "device_state":
      return [{ device: e.device, state: e.state }];
    case "not":
      return deviceStates(e.operand);
    case "and":
    case "or":
    case "compare":
      return [...deviceStates(e.left), ...deviceStates(e.right)];
    default:
      return [];
  }
}

/** The action that puts a device into `state`, for the homing hint. */
function homeAction(ir: StationIR, device: string, state: string): string {
  const kind = DEVICE_KINDS.get(ir.devices.find((d) => d.name === device)!.kind)!;
  return Object.keys(kind.actions).find((a) => kind.actions[a]!.done === state) ?? Object.keys(kind.actions)[0]!;
}

function tooLarge(ir: StationIR, program: A.Program, atoms: string[]): Diagnostic {
  const names = atoms.map((a) => (a.startsWith("{") ? "a comparison on a real input" : a));
  return {
    code: "T0210",
    severity: "error",
    message: `station \`${ir.name}\` has ${atoms.length} inputs to explore; the interlock proof handles at most ${MAX_FREE_INPUTS}`,
    messageJa: `ステーション \`${ir.name}\` には探索する入力が ${atoms.length} 個あります。インターロック証明は最大 ${MAX_FREE_INPUTS} 個までです`,
    span: program.station.name.span,
    label: "too many inputs",
    notes: [`inputs: ${names.join(", ")}`],
    help: "split the machine into smaller stations, each with its own sequence",
  };
}
