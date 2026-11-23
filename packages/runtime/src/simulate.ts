// The simulation behind `tejun run` and the playground: each scan, gather
// inputs (scenario or manual values, simulated devices, follows, jams), run
// one scan of the station, then let the devices move for one scan time.
//
// `Simulation` advances one scan at a time (the playground drives it live);
// `simulate()` runs one to the end (the CLI). Both use the same code.

import type { StationIR } from "@tejun/compiler";
import { DEFAULT_TRAVEL_MS, Plant } from "./plant.js";
import type { Scenario, ScenarioFollow, ScenarioSet } from "./scenario.js";
import { STOPPED, StationRuntime, type FaultCause, type Inputs } from "./station.js";

export const DEFAULT_SCAN_MS = 20;
export const DEFAULT_UNTIL_MS = 10_000;

/** A sensor forced to a value, to simulate a stuck or broken sensor. */
export interface Jam {
  sensor: string;
  value: boolean;
}

export interface SimulationOptions {
  scenario?: Scenario;
  jams?: readonly Jam[];
  scanMs?: number;
  /** End time; defaults to the scenario's `until`, then 10 s. Use Infinity to run until Stopped. */
  untilMs?: number;
  travelMs?: number;
  /** Keep a record of every scan (default true; the playground turns it off). */
  keepTrace?: boolean;
}

export type TimelineEvent =
  | { kind: "start"; state: string; outputs: string[] | undefined }
  | { kind: "input"; signal: string; value: boolean | number; source: string }
  | { kind: "fault"; fault: string; number: number; cause: FaultCause }
  | { kind: "transition"; from: string; to: string; outputs: string[]; reason: string | undefined }
  | { kind: "violation"; interlock: string };

export interface TimedEvent {
  timeMs: number;
  event: TimelineEvent;
}

/** Everything about one scan, for the equivalence test and the playground. */
export interface ScanRecord {
  timeMs: number;
  inputs: Inputs;
  outputs: Readonly<Record<string, boolean>>;
  state: string;
  stateNumber: number;
  fault: string | undefined;
  faultNumber: number;
}

export interface SimulationResult {
  events: TimedEvent[];
  trace: ScanRecord[];
  end: { timeMs: number; state: string; fault: string | undefined; reason: "stopped" | "time limit" };
  scanMs: number;
}

export class Simulation {
  readonly ir: StationIR;
  readonly scanMs: number;
  readonly untilMs: number;
  readonly plant: Plant;
  readonly station: StationRuntime;
  /** Every event so far. */
  readonly events: TimedEvent[] = [];
  /** Every scan so far, if `keepTrace`. */
  readonly trace: ScanRecord[] = [];
  /** The most recent scan. */
  last: ScanRecord | undefined;
  /** Time of the next scan. */
  timeMs = 0;

  private readonly keepTrace: boolean;
  private readonly sets: readonly ScenarioSet[];
  private readonly follows: readonly ScenarioFollow[];
  private readonly inputSignals: string[];
  private jams: Map<string, boolean>;
  /** Scenario, manual or default values for inputs no device drives. */
  private readonly values: Record<string, boolean | number>;
  /** Where each of `values` came from: "default", "scenario" or "manual". */
  private readonly valueSource = new Map<string, string>();
  /** Output -> changes as [time, value], for follows. */
  private readonly history: Map<string, [number, boolean][]>;
  private previous: Inputs | undefined;
  private nextSet = 0;

  constructor(ir: StationIR, options: SimulationOptions = {}) {
    this.ir = ir;
    this.scanMs = options.scanMs ?? DEFAULT_SCAN_MS;
    this.untilMs = options.untilMs ?? options.scenario?.untilMs ?? DEFAULT_UNTIL_MS;
    this.plant = new Plant(ir, options.travelMs ?? DEFAULT_TRAVEL_MS);
    this.station = new StationRuntime(ir);
    this.keepTrace = options.keepTrace ?? true;
    this.sets = options.scenario?.sets ?? [];
    this.follows = options.scenario?.follows ?? [];
    this.jams = new Map((options.jams ?? []).map((j) => [j.sensor, j.value]));
    const inputs = ir.signals.filter((s) => s.direction === "input");
    this.inputSignals = inputs.map((s) => s.name);
    this.values = Object.fromEntries(
      inputs.map((s) => [s.name, s.type === "bool" ? s.safety : Math.max(0, s.range?.min ?? 0)]),
    );
    for (const name of this.inputSignals) this.valueSource.set(name, "default");
    this.history = new Map(this.follows.map((f) => [f.output, [[-Infinity, false]]]));
  }

  /** True once the machine is Stopped or the end time has passed. */
  get finished(): boolean {
    return this.last?.state === STOPPED || this.timeMs > this.untilMs;
  }

  /** Set an input by hand (the playground's switches). Device sensors and follows ignore this. */
  setInput(name: string, value: boolean | number): void {
    if (!(name in this.values)) throw new Error(`unknown input ${name}`);
    this.values[name] = value;
    this.valueSource.set(name, "manual");
  }

  /** Value an input will have unless a device, follow or jam overrides it. */
  inputValue(name: string): boolean | number | undefined {
    return this.values[name];
  }

  /** Replace the set of jammed sensors. */
  setJams(jams: readonly Jam[]): void {
    this.jams = new Map(jams.map((j) => [j.sensor, j.value]));
  }

  /** Run one scan. Returns the events it produced (empty if already finished). */
  step(): TimedEvent[] {
    if (this.finished) return [];
    const timeMs = this.timeMs;
    const added: TimedEvent[] = [];
    const push = (event: TimelineEvent) => added.push({ timeMs, event });

    while (this.nextSet < this.sets.length && this.sets[this.nextSet]!.atMs <= timeMs) {
      const s = this.sets[this.nextSet++]!;
      this.values[s.signal] = s.value;
      this.valueSource.set(s.signal, "scenario");
    }

    const inputs: Record<string, boolean | number> = { ...this.values, ...this.plant.sensors() };
    const sources = new Map<string, string>([...this.valueSource, ...this.plant.owned]);
    for (const f of this.follows) {
      const changes = this.history.get(f.output)!;
      inputs[f.input] = changes.filter(([t]) => t + f.delayMs <= timeMs).at(-1)![1];
      sources.set(f.input, `follows ${f.output}`);
    }
    for (const [sensor, value] of this.jams) {
      inputs[sensor] = value;
      sources.set(sensor, "jammed");
    }

    if (timeMs === 0) push({ kind: "start", state: this.ir.initialState, outputs: undefined });
    for (const name of this.inputSignals) {
      const value = inputs[name]!;
      const changed = this.previous === undefined ? value !== false && value !== 0 : this.previous[name] !== value;
      if (changed) push({ kind: "input", signal: name, value, source: sources.get(name)! });
    }

    const result = this.station.scan(inputs, timeMs);
    const on = Object.entries(result.outputs).filter(([, v]) => v).map(([k]) => k);
    let stopReason: string | undefined;
    for (const e of result.events) {
      if (e.kind === "fault") push(e);
      if (e.kind === "stopped") stopReason = `E-stop: ${e.condition}`;
      if (e.kind === "transition") push({ kind: "transition", from: e.from, to: e.to, outputs: on, reason: stopReason });
      if (e.kind === "violation") push(e);
    }
    if (timeMs === 0 && result.state === this.ir.initialState) {
      const start = added[0]!.event;
      if (start.kind === "start") start.outputs = on;
    }

    const record: ScanRecord = {
      timeMs,
      inputs,
      outputs: result.outputs,
      state: result.state,
      stateNumber: this.station.stateNumber(),
      fault: result.fault,
      faultNumber: this.station.faultNumber(),
    };
    this.last = record;
    if (this.keepTrace) this.trace.push(record);

    this.plant.advance(result.outputs, this.scanMs);
    for (const [output, changes] of this.history) {
      const value = result.outputs[output] === true;
      if (changes.at(-1)![1] !== value) changes.push([timeMs, value]);
    }
    this.previous = inputs;
    this.timeMs += this.scanMs;
    this.events.push(...added);
    return added;
  }
}

/** Run a simulation to the end (Stopped or the end time). */
export function simulate(ir: StationIR, options: SimulationOptions = {}): SimulationResult {
  const sim = new Simulation(ir, options);
  while (!sim.finished) sim.step();
  const last = sim.last!;
  return {
    events: sim.events,
    trace: sim.trace,
    end: { timeMs: last.timeMs, state: last.state, fault: last.fault, reason: last.state === STOPPED ? "stopped" : "time limit" },
    scanMs: sim.scanMs,
  };
}
