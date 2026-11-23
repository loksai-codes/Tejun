// The simulation loop behind `tejun run`: each scan, gather inputs (scenario,
// simulated devices, follows, jams), run one scan of the station, then let
// the devices move for one scan time.

import type { StationIR } from "@tejun/compiler";
import { DEFAULT_TRAVEL_MS, Plant } from "./plant.js";
import type { Scenario } from "./scenario.js";
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
  /** End time; defaults to the scenario's `until`, then 10 s. */
  untilMs?: number;
  travelMs?: number;
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

export function simulate(ir: StationIR, options: SimulationOptions = {}): SimulationResult {
  const scanMs = options.scanMs ?? DEFAULT_SCAN_MS;
  const untilMs = options.untilMs ?? options.scenario?.untilMs ?? DEFAULT_UNTIL_MS;
  const plant = new Plant(ir, options.travelMs ?? DEFAULT_TRAVEL_MS);
  const station = new StationRuntime(ir);
  const jams = new Map((options.jams ?? []).map((j) => [j.sensor, j.value]));
  const sets = options.scenario?.sets ?? [];
  const follows = options.scenario?.follows ?? [];
  const inputSignals = ir.signals.filter((s) => s.direction === "input");

  // Scenario-driven values, starting from the defaults.
  const scripted: Record<string, boolean | number> = Object.fromEntries(
    inputSignals.map((s) => [s.name, s.type === "bool" ? s.safety : Math.max(0, s.range?.min ?? 0)]),
  );
  /** Output -> changes as [time, value], for follows. */
  const history = new Map<string, [number, boolean][]>(follows.map((f) => [f.output, [[-Infinity, false]]]));

  /** Inputs the scenario has set so far (others still have their default). */
  const setByScenario = new Set<string>();
  const events: TimedEvent[] = [];
  const trace: ScanRecord[] = [];
  let previous: Inputs | undefined;
  let nextSet = 0;
  let timeMs = 0;

  for (; timeMs <= untilMs; timeMs += scanMs) {
    while (nextSet < sets.length && sets[nextSet]!.atMs <= timeMs) {
      const s = sets[nextSet++]!;
      scripted[s.signal] = s.value;
      setByScenario.add(s.signal);
    }

    const inputs: Record<string, boolean | number> = { ...scripted, ...plant.sensors() };
    const sources = new Map<string, string>([...plant.owned]);
    for (const f of follows) {
      const changes = history.get(f.output)!;
      inputs[f.input] = changes.filter(([t]) => t + f.delayMs <= timeMs).at(-1)![1];
      sources.set(f.input, `follows ${f.output}`);
    }
    for (const [sensor, value] of jams) {
      inputs[sensor] = value;
      sources.set(sensor, "jammed");
    }

    if (timeMs === 0) events.push({ timeMs, event: { kind: "start", state: ir.initialState, outputs: undefined } });
    for (const s of inputSignals) {
      const value = inputs[s.name]!;
      const changed = previous === undefined ? value !== false && value !== 0 : previous[s.name] !== value;
      if (changed) events.push({ timeMs, event: { kind: "input", signal: s.name, value, source: sources.get(s.name) ?? (setByScenario.has(s.name) ? "scenario" : "default") } });
    }

    const result = station.scan(inputs, timeMs);
    const on = Object.entries(result.outputs).filter(([, v]) => v).map(([k]) => k);
    let stopReason: string | undefined;
    for (const e of result.events) {
      if (e.kind === "fault") events.push({ timeMs, event: e });
      if (e.kind === "stopped") stopReason = `E-stop: ${e.condition}`;
      if (e.kind === "transition") {
        events.push({ timeMs, event: { kind: "transition", from: e.from, to: e.to, outputs: on, reason: stopReason } });
      }
      if (e.kind === "violation") events.push({ timeMs, event: e });
    }
    if (timeMs === 0 && result.state === ir.initialState) {
      const start = events[0]!.event;
      if (start.kind === "start") start.outputs = on;
    }

    trace.push({
      timeMs,
      inputs,
      outputs: result.outputs,
      state: result.state,
      stateNumber: station.stateNumber(),
      fault: result.fault,
      faultNumber: station.faultNumber(),
    });

    plant.advance(result.outputs, scanMs);
    for (const [output, changes] of history) {
      const value = result.outputs[output] === true;
      if (changes.at(-1)![1] !== value) changes.push([timeMs, value]);
    }
    previous = inputs;
    if (result.state === STOPPED) break;
  }

  const last = trace.at(-1)!;
  return {
    events,
    trace,
    end: { timeMs: last.timeMs, state: last.state, fault: last.fault, reason: last.state === STOPPED ? "stopped" : "time limit" },
    scanMs,
  };
}
