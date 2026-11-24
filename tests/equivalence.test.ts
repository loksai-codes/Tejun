// The simulator must behave exactly like the generated PLC code. For every
// example this runs the IR interpreter (packages/runtime) and the generated
// Structured Text (through tests/support/st-interpreter.ts) on the same
// inputs, scan by scan, and compares every output, the state number and the
// fault number:
//   - the example scenario, and the scenario with each device sensor jammed
//     OFF and ON (driven by the simulated machine)
//   - seeded random inputs, including random sensor values no real machine
//     would produce
//   - the device position check: for every device, a sensor stuck ON, a
//     sensor failing OFF, the cylinder moved by hand (to the other end and
//     to mid-stroke), and a glitch shorter than the debounce time

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POSITION_DEBOUNCE_MS,
  POSITION_MISMATCH,
  build,
  type ExprIR,
  type InterlockIR,
  type StationIR,
} from "@tejun/compiler";
import {
  DEFAULT_TRAVEL_MS,
  Plant,
  Simulation,
  StationRuntime,
  parseScenario,
  simulate,
  type Inputs,
  type Jam,
  type ScanRecord,
  type Scenario,
} from "@tejun/runtime";
import { StFunctionBlock } from "./support/st-interpreter.js";

const examplesDir = new URL("../examples/", import.meta.url);
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".tejun"));
const SCAN_MS = 20;

function compile(file: string): { ir: StationIR; st: string } {
  const result = build(`examples/${file}`, readFileSync(new URL(file, examplesDir), "utf8"));
  expect(result.diagnostics).toEqual([]);
  return { ir: result.ir!, st: result.st! };
}

interface Expected {
  outputs: Readonly<Record<string, boolean>>;
  stateNumber: number;
  faultNumber: number;
}

/** Feed one scan into the generated block and return the first mismatch, if any. */
function compareScan(fb: StFunctionBlock, ir: StationIR, inputs: Inputs, timeMs: number, expected: Expected): string | undefined {
  for (const s of ir.signals) if (s.direction === "input") fb.set(s.name, inputs[s.name] ?? false);
  fb.call(timeMs);
  const actual = {
    outputs: Object.fromEntries(Object.keys(expected.outputs).map((o) => [o, fb.get(o)])),
    stateNumber: fb.get("tj_state"),
    faultNumber: fb.get("tj_fault"),
  };
  const same =
    actual.stateNumber === expected.stateNumber &&
    actual.faultNumber === expected.faultNumber &&
    Object.keys(expected.outputs).every((o) => actual.outputs[o] === expected.outputs[o]);
  return same ? undefined : `at ${timeMs} ms: IR ${JSON.stringify(expected)} vs ST ${JSON.stringify(actual)}`;
}

/** A small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(examples)("%s: simulator and generated ST agree", (file) => {
  const { ir, st } = compile(file);
  const scenarioText = readFileSync(new URL(file.replace(".tejun", ".scenario"), examplesDir), "utf8");
  const owned = new Plant(ir).owned;
  const scenario = parseScenario(scenarioText, ir, owned).scenario!;
  const runs: [string, Jam[]][] = [
    ["scenario", []],
    ...[...owned.keys()].flatMap((sensor): [string, Jam[]][] => [
      [`scenario, ${sensor} stuck OFF`, [{ sensor, value: false }]],
      [`scenario, ${sensor} stuck ON`, [{ sensor, value: true }]],
    ]),
  ];

  it.each(runs)("%s", (_name, jams) => {
    const result = simulate(ir, { scenario, jams, scanMs: SCAN_MS });
    const fb = new StFunctionBlock(st);
    expect(fb.name).toBe(ir.name.toLowerCase()); // ST identifiers are case-insensitive
    for (const record of result.trace) {
      expect(compareScan(fb, ir, record.inputs, record.timeMs, record)).toBeUndefined();
    }
    // A sensor stuck ON can stop the machine after one debounce time (6 scans).
    expect(result.trace.length).toBeGreaterThan(POSITION_DEBOUNCE_MS / SCAN_MS);
    // A healthy machine never trips the position check.
    if (jams.length === 0) expect(result.end.fault).not.toBe(POSITION_MISMATCH);
  });

  // Random sensor values often trip the position check early, so this uses
  // more seeds than it otherwise would to reach deep into the sequence.
  it("random inputs, 100 seeds", () => {
    let scans = 0;
    const statesSeen = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      const rand = random(seed);
      const runtime = new StationRuntime(ir);
      const fb = new StFunctionBlock(st);
      // Half the seeds never press E-stop, to get deeper into the sequence.
      const estopRate = seed % 2 === 0 ? 0 : 0.005;
      const inputs: Record<string, boolean | number> = {};
      for (const s of ir.signals) if (s.direction === "input") inputs[s.name] = s.type === "bool" ? s.safety : 0;

      for (let scan = 0; scan < 1500; scan++) {
        const timeMs = scan * SCAN_MS;
        for (const s of ir.signals) {
          if (s.direction !== "input") continue;
          if (s.safety) inputs[s.name] = rand() >= estopRate;
          else if (s.type === "bool") inputs[s.name] = rand() < 0.15 ? !inputs[s.name] : inputs[s.name]!;
          else if (rand() < 0.05) inputs[s.name] = Math.round(rand() * 1.2 * (s.range?.max ?? 100));
        }
        const r = runtime.scan(inputs, timeMs);
        // The runtime re-checks every proved interlock after each scan.
        expect(r.events.filter((e) => e.kind === "violation"), `seed ${seed}`).toEqual([]);
        const expected = { outputs: r.outputs, stateNumber: runtime.stateNumber(), faultNumber: runtime.faultNumber() };
        const mismatch = compareScan(fb, ir, inputs, timeMs, expected);
        expect(mismatch, `seed ${seed}`).toBeUndefined();
        statesSeen.add(expected.stateNumber);
        scans++;
        if (r.state === "Stopped") break;
      }
    }
    expect(scans).toBeGreaterThan(1000);
    // Random inputs should reach most of the state graph.
    expect(statesSeen.size).toBeGreaterThan(ir.states.length / 2);
  });
});

/** Compare a whole trace against the generated ST; returns the first mismatch. */
function compareTrace(st: string, ir: StationIR, trace: readonly ScanRecord[]): string | undefined {
  const fb = new StFunctionBlock(st);
  for (const r of trace) {
    const mismatch = compareScan(fb, ir, r.inputs, r.timeMs, r);
    if (mismatch) return mismatch;
  }
  return undefined;
}

/**
 * Whether a `never` / `requires` interlock is violated on the *real* machine:
 * device states come from the simulated cylinders' actual positions, not
 * from the program's tracked positions. Cylinder only (0 = retracted, 1 = extended).
 */
function physicallyViolated(i: InterlockIR, r: ScanRecord, positions: Readonly<Record<string, number>>): boolean {
  const value = (e: ExprIR): boolean | number => {
    switch (e.kind) {
      case "signal":
        return e.name in r.outputs ? r.outputs[e.name]! : (r.inputs[e.name] ?? false);
      case "device_state":
        return e.state === "extended" ? positions[e.device]! >= 1 : positions[e.device]! <= 0;
      case "number":
        return e.value;
      case "not":
        return !value(e.operand);
      case "and":
        return Boolean(value(e.left)) && Boolean(value(e.right));
      case "or":
        return Boolean(value(e.left)) || Boolean(value(e.right));
      case "compare": {
        const [l, rr] = [value(e.left), value(e.right)];
        return { "==": l === rr, "!=": l !== rr, "<": l < rr, "<=": l <= rr, ">": l > rr, ">=": l >= rr }[e.op];
      }
    }
  };
  if (i.kind === "never") return Boolean(value(i.condition));
  if (i.kind === "requires") return r.outputs[i.output] === true && !value(i.condition);
  return false;
}

/**
 * Run the scenario, calling `before(sim)` before every scan. Returns the
 * trace and the times of scans whose outputs violate a proved interlock on
 * the real machine.
 */
function runWith(
  ir: StationIR,
  scenario: Scenario,
  before: (sim: Simulation) => void,
  jams: Jam[] = [],
): { trace: readonly ScanRecord[]; physical: number[] } {
  const sim = new Simulation(ir, { scenario, jams, scanMs: SCAN_MS, untilMs: 20_000 });
  const physical: number[] = [];
  while (!sim.finished) {
    before(sim);
    const positions = sim.plant.positions(); // what the sensors read this scan
    sim.step();
    if (ir.interlocks.some((i) => physicallyViolated(i, sim.last!, positions))) physical.push(sim.last!.timeMs);
  }
  // Judged on tracked positions, the proved interlocks always hold, even with
  // failed sensors and devices moved by hand.
  expect(sim.events.filter((e) => e.event.kind === "violation")).toEqual([]);
  return { trace: sim.trace, physical };
}

/**
 * The first time the healthy run has `device` resting at one of its ends for
 * longer than the debounce time (plus margin), so a disturbance there is not
 * masked by the program starting a new move.
 */
function restingWindow(ir: StationIR, scenario: Scenario, device: string): { timeMs: number; end: string } | undefined {
  const ends = Object.keys(ir.devices.find((d) => d.name === device)!.sensors);
  const needed = POSITION_DEBOUNCE_MS / SCAN_MS + 4;
  const positions: { timeMs: number; pos: string }[] = [];
  const healthy = runWith(ir, scenario, (sim) => positions.push({ timeMs: sim.timeMs, pos: sim.station.pos[device]! }));
  expect(healthy.physical, "a healthy run never violates an interlock on the real machine").toEqual([]);
  for (let i = 0; i + needed <= positions.length; i++) {
    const pos = positions[i]!.pos;
    if (ends.includes(pos) && positions.slice(i, i + needed).every((p) => p.pos === pos)) {
      return { timeMs: positions[i + 1]!.timeMs, end: pos };
    }
  }
  return undefined;
}

describe.each(examples)("%s: device position check, simulator and generated ST agree", (file) => {
  const { ir, st } = compile(file);
  const scenarioText = readFileSync(new URL(file.replace(".tejun", ".scenario"), examplesDir), "utf8");
  const scenario = parseScenario(scenarioText, ir, new Plant(ir).owned).scenario!;
  const devices = ir.devices.map((d) => d.name);
  const sensors = (device: string) => ir.devices.find((d) => d.name === device)!.sensors;
  const otherEnd = (device: string, end: string) => Object.keys(sensors(device)).find((e) => e !== end)!;

  /** The first fault is POSITION_MISMATCH, raised in Stopped with every output OFF; returns its time. */
  function expectMismatch(trace: readonly ScanRecord[]): number {
    const faulted = trace.find((r) => r.fault !== undefined);
    expect(faulted?.fault).toBe(POSITION_MISMATCH);
    expect(faulted!.state).toBe("Stopped");
    expect(Object.values(faulted!.outputs).every((v) => v === false)).toBe(true);
    return faulted!.timeMs;
  }

  /**
   * Disturb `device` while it rests at an end; expect POSITION_MISMATCH
   * exactly one debounce time later, and any real-world interlock violation
   * only between the disturbance and the fault.
   */
  function expectCaught(device: string, disturb: (sim: Simulation, end: string) => void): void {
    const window = restingWindow(ir, scenario, device);
    expect(window, "the scenario rests the device at an end").toBeDefined();
    const { trace, physical } = runWith(ir, scenario, (sim) => {
      if (sim.timeMs === window!.timeMs) disturb(sim, window!.end);
    });
    expect(compareTrace(st, ir, trace)).toBeUndefined();
    const faultMs = expectMismatch(trace);
    expect(faultMs - window!.timeMs).toBe(POSITION_DEBOUNCE_MS);
    expect(physical.every((t) => t >= window!.timeMs && t < faultMs), `real violations at ${physical}`).toBe(true);
  }

  it.each(devices)("%s: an end sensor stuck ON is caught once the real machine contradicts it", (device) => {
    for (const sensor of Object.values(sensors(device))) {
      // The first scan in which the real sensor would be OFF.
      let contradicted: number | undefined;
      const { trace, physical } = runWith(
        ir,
        scenario,
        (sim) => {
          if (contradicted === undefined && !sim.plant.sensors()[sensor]) contradicted = sim.timeMs;
        },
        [{ sensor, value: true }],
      );
      expect(compareTrace(st, ir, trace), sensor).toBeUndefined();
      expect(contradicted, `${sensor}: the scenario moves the device off it`).toBeDefined();
      // At the latest: the device reaches the other end, then the debounce time.
      const faultMs = expectMismatch(trace);
      expect(faultMs - contradicted!, sensor).toBeLessThanOrEqual(DEFAULT_TRAVEL_MS + POSITION_DEBOUNCE_MS);
      expect(physical.every((t) => t >= contradicted! && t < faultMs), `${sensor}: real violations at ${physical}`).toBe(true);
    }
  });

  it.each(devices)("%s: an end sensor stuck OFF from the start gives a timeout, not a mismatch", (device) => {
    for (const sensor of Object.values(sensors(device))) {
      const { trace, physical } = runWith(ir, scenario, () => {}, [{ sensor, value: false }]);
      expect(physical, sensor).toEqual([]);
      expect(compareTrace(st, ir, trace), sensor).toBeUndefined();
      expect(trace.some((r) => r.fault === POSITION_MISMATCH), sensor).toBe(false);
    }
  });

  it.each(devices)("%s: the sensor of the end it rests at fails OFF", (device) => {
    expectCaught(device, (sim, end) => sim.setJams([{ sensor: sensors(device)[end]!, value: false }]));
  });

  it.each(devices)("%s: moved by hand to the other end", (device) => {
    expectCaught(device, (sim, end) => sim.plant.moveByHand(device, otherEnd(device, end) === "extended" ? 1 : 0));
  });

  it.each(devices)("%s: moved by hand to mid-stroke", (device) => {
    expectCaught(device, (sim) => sim.plant.moveByHand(device, 0.5));
  });

  it.each(devices)("%s: a sensor glitch shorter than the debounce time is ignored", (device) => {
    const window = restingWindow(ir, scenario, device);
    expect(window).toBeDefined();
    const glitchEnd = window!.timeMs + POSITION_DEBOUNCE_MS - 2 * SCAN_MS;
    const { trace } = runWith(ir, scenario, (sim) => {
      if (sim.timeMs === window!.timeMs) sim.setJams([{ sensor: sensors(device)[window!.end]!, value: false }]);
      if (sim.timeMs === glitchEnd) sim.setJams([]);
    });
    expect(compareTrace(st, ir, trace)).toBeUndefined();
    expect(trace.some((r) => r.fault === POSITION_MISMATCH)).toBe(false);
  });
});

describe("ST interpreter self-check", () => {
  it.each([
    ["an output assigned in the wrong state", "conveyor := (tj_state = 2);", "conveyor := (tj_state = 3);"],
    ["a timeout one scan too long", "PT := T#2000ms", "PT := T#2020ms"],
    ["a transition to the wrong state", "tj_state := 4; (* Press *)", "tj_state := 5; (* Press *)"],
  ])("catches a deliberately broken generator: %s", (_name, from, to) => {
    const { ir, st } = compile("press_feeder.tejun");
    expect(st).toContain(from);
    const broken = new StFunctionBlock(st.replace(from, to));
    const jams = from.startsWith("PT") ? [{ sensor: "clamp_ret_ls", value: false }] : [];
    const result = simulate(ir, { scenario: parseScenario("at 1 s part_present = on", ir, new Plant(ir).owned).scenario!, jams });
    const mismatches = result.trace.map((r) => compareScan(broken, ir, r.inputs, r.timeMs, r)).filter(Boolean);
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it("rejects code outside the supported subset", () => {
    expect(() => new StFunctionBlock("FUNCTION_BLOCK X\n  VAR\n    s : STRING;\n  END_VAR\nEND_FUNCTION_BLOCK")).toThrow(
      "unsupported type string",
    );
  });
});
