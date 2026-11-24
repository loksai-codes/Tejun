// The simulator must behave exactly like the generated PLC code. For every
// example this runs the IR interpreter (packages/runtime) and the generated
// Structured Text (through tests/support/st-interpreter.ts) on the same
// inputs, scan by scan, and compares every output, the state number and the
// fault number:
//   - the example scenario, and the scenario with each device sensor jammed
//     OFF and ON (driven by the simulated machine)
//   - seeded random inputs, including random sensor values no real machine
//     would produce
//   - the device check: for every cylinder, a sensor stuck ON or OFF, a
//     sensor failing OFF, the cylinder moved by hand (to the other end and
//     to mid-stroke), and a glitch shorter than the debounce time; for every
//     motor, its feedback stuck OFF or ON, lost while running, coming on
//     while stopped, and a short glitch

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_FAULTS,
  FEEDBACK_MISMATCH,
  MISMATCH_DEBOUNCE_MS,
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
    expect(result.trace.length).toBeGreaterThan(MISMATCH_DEBOUNCE_MS / SCAN_MS);
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
 * Whether a device state holds on the *real* (simulated) machine:
 * a cylinder's extension from 0 (retracted) to 1 (extended), or a motor's
 * speed from 0 (standstill) to 1 (full speed).
 */
function physically(ir: StationIR, device: string, state: string, positions: Readonly<Record<string, number>>): boolean {
  const kind = ir.devices.find((d) => d.name === device)!.kind;
  const p = positions[device]!;
  if (kind === "Cylinder") return state === "extended" ? p >= 1 : p <= 0;
  return state === "running" ? p >= 1 : p <= 0;
}

/**
 * Whether a `never` / `requires` interlock is violated on the real machine:
 * device states come from the simulated devices, not from the program's
 * tracked states.
 */
function physicallyViolated(ir: StationIR, i: InterlockIR, r: ScanRecord, positions: Readonly<Record<string, number>>): boolean {
  const value = (e: ExprIR): boolean | number => {
    switch (e.kind) {
      case "signal":
        return e.name in r.outputs ? r.outputs[e.name]! : (r.inputs[e.name] ?? false);
      case "device_state":
        return physically(ir, e.device, e.state, positions);
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
    if (ir.interlocks.some((i) => physicallyViolated(ir, i, sim.last!, positions))) physical.push(sim.last!.timeMs);
  }
  // Judged on tracked states, the proved interlocks always hold, even with
  // failed sensors and devices moved by hand.
  expect(sim.events.filter((e) => e.event.kind === "violation")).toEqual([]);
  return { trace: sim.trace, physical };
}

/**
 * The first time the healthy run has `device` tracked in one of `wanted`
 * for longer than the debounce time (plus margin), so a disturbance there is
 * not masked by the program starting a new action.
 */
function restingWindow(
  ir: StationIR,
  scenario: Scenario,
  device: string,
  wanted: readonly string[],
): { timeMs: number; state: string } | undefined {
  const needed = MISMATCH_DEBOUNCE_MS / SCAN_MS + 4;
  const tracked: { timeMs: number; state: string }[] = [];
  const healthy = runWith(ir, scenario, (sim) => tracked.push({ timeMs: sim.timeMs, state: sim.station.pos[device]! }));
  expect(healthy.physical, "a healthy run never violates an interlock on the real machine").toEqual([]);
  for (let i = 0; i + needed <= tracked.length; i++) {
    const state = tracked[i]!.state;
    if (wanted.includes(state) && tracked.slice(i, i + needed).every((p) => p.state === state)) {
      return { timeMs: tracked[i + 1]!.timeMs, state };
    }
  }
  return undefined;
}

describe.each(examples)("%s: device check, simulator and generated ST agree", (file) => {
  const { ir, st } = compile(file);
  const scenarioText = readFileSync(new URL(file.replace(".tejun", ".scenario"), examplesDir), "utf8");
  const scenario = parseScenario(scenarioText, ir, new Plant(ir).owned).scenario!;
  const deviceIR = (device: string) => ir.devices.find((d) => d.name === device)!;
  const cylinders = ir.devices.filter((d) => d.kind === "Cylinder").map((d) => d.name);
  const motors = ir.devices.filter((d) => d.kind === "Motor").map((d) => d.name);
  const sensorOf = (device: string, state: string) => deviceIR(device).states[state]!.sensor;
  const ends = ["extended", "retracted"];
  const otherEnd = (end: string) => ends.find((e) => e !== end)!;

  it("never raises a device fault on the healthy scenario", () => {
    const result = simulate(ir, { scenario, scanMs: SCAN_MS });
    expect(result.trace.some((r) => r.fault !== undefined && BUILTIN_FAULTS.includes(r.fault))).toBe(false);
  });

  /** The first fault is `fault`, raised in Stopped with every output OFF; returns its time. */
  function expectFault(trace: readonly ScanRecord[], fault: string): number {
    const faulted = trace.find((r) => r.fault !== undefined);
    expect(faulted?.fault).toBe(fault);
    expect(faulted!.state).toBe("Stopped");
    expect(Object.values(faulted!.outputs).every((v) => v === false)).toBe(true);
    return faulted!.timeMs;
  }

  /**
   * Disturb `device` while it rests in one of `wanted`; expect its mismatch
   * fault exactly one debounce time later, and any real-world interlock
   * violation only between the disturbance and the fault.
   */
  function expectCaught(device: string, wanted: readonly string[], disturb: (sim: Simulation, state: string) => void): void {
    const window = restingWindow(ir, scenario, device, wanted);
    expect(window, `the scenario rests ${device} in ${wanted.join(" or ")}`).toBeDefined();
    const { trace, physical } = runWith(ir, scenario, (sim) => {
      if (sim.timeMs === window!.timeMs) disturb(sim, window!.state);
    });
    expect(compareTrace(st, ir, trace)).toBeUndefined();
    const faultMs = expectFault(trace, deviceIR(device).mismatchFault);
    expect(faultMs - window!.timeMs).toBe(MISMATCH_DEBOUNCE_MS);
    expect(physical.every((t) => t >= window!.timeMs && t < faultMs), `real violations at ${physical}`).toBe(true);
  }

  /** A glitch shorter than the debounce time on `sensor` while `device` rests in one of `wanted` is ignored. */
  function expectGlitchIgnored(device: string, wanted: readonly string[], value: boolean): void {
    const window = restingWindow(ir, scenario, device, wanted);
    expect(window).toBeDefined();
    const sensor = sensorOf(device, window!.state);
    const glitchEnd = window!.timeMs + MISMATCH_DEBOUNCE_MS - 2 * SCAN_MS;
    const { trace } = runWith(ir, scenario, (sim) => {
      if (sim.timeMs === window!.timeMs) sim.setJams([{ sensor, value }]);
      if (sim.timeMs === glitchEnd) sim.setJams([]);
    });
    expect(compareTrace(st, ir, trace)).toBeUndefined();
    expect(trace.some((r) => r.fault === deviceIR(device).mismatchFault)).toBe(false);
  }

  // ----- Cylinder -----

  if (cylinders.length > 0) {
    it.each(cylinders)("cylinder %s: an end sensor stuck ON is caught once the real machine contradicts it", (device) => {
      for (const end of ends) {
        const sensor = sensorOf(device, end);
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
        const faultMs = expectFault(trace, POSITION_MISMATCH);
        expect(faultMs - contradicted!, sensor).toBeLessThanOrEqual(DEFAULT_TRAVEL_MS + MISMATCH_DEBOUNCE_MS);
        expect(physical.every((t) => t >= contradicted! && t < faultMs), `${sensor}: real violations at ${physical}`).toBe(true);
      }
    });

    it.each(cylinders)("cylinder %s: an end sensor stuck OFF from the start gives a timeout, not a mismatch", (device) => {
      for (const end of ends) {
        const sensor = sensorOf(device, end);
        const { trace, physical } = runWith(ir, scenario, () => {}, [{ sensor, value: false }]);
        expect(compareTrace(st, ir, trace), sensor).toBeUndefined();
        expect(physical, sensor).toEqual([]);
        expect(trace.some((r) => r.fault === POSITION_MISMATCH), sensor).toBe(false);
      }
    });

    it.each(cylinders)("cylinder %s: the sensor of the end it rests at fails OFF", (device) => {
      expectCaught(device, ends, (sim, end) => sim.setJams([{ sensor: sensorOf(device, end), value: false }]));
    });

    it.each(cylinders)("cylinder %s: moved by hand to the other end", (device) => {
      expectCaught(device, ends, (sim, end) => sim.plant.moveByHand(device, otherEnd(end) === "extended" ? 1 : 0));
    });

    it.each(cylinders)("cylinder %s: moved by hand to mid-stroke", (device) => {
      expectCaught(device, ends, (sim) => sim.plant.moveByHand(device, 0.5));
    });

    it.each(cylinders)("cylinder %s: a sensor glitch shorter than the debounce time is ignored", (device) => {
      expectGlitchIgnored(device, ends, false);
    });
  }

  // ----- Motor -----

  if (motors.length > 0) {
    it.each(motors)("motor %s: feedback stuck OFF gives the start timeout, not a mismatch", (device) => {
      const sensor = sensorOf(device, "running");
      const { trace, physical } = runWith(ir, scenario, () => {}, [{ sensor, value: false }]);
      expect(compareTrace(st, ir, trace)).toBeUndefined();
      expect(physical).toEqual([]);
      const run = ir.states.find((s) => s.step?.kind === "device" && s.step.device === device)!.step!;
      expect(run.kind === "device" && run.timeout.kind === "within").toBe(true);
      if (run.kind === "device" && run.timeout.kind === "within") expectFault(trace, run.timeout.fault);
    });

    it.each(motors)("motor %s: feedback stuck ON never confirms standstill, so nothing that requires it runs", (device) => {
      const sensor = sensorOf(device, "running");
      const { trace, physical } = runWith(ir, scenario, () => {}, [{ sensor, value: true }]);
      expect(compareTrace(st, ir, trace)).toBeUndefined();
      // The motor is never tracked stopped, so an interlock requiring it holds on the real machine too.
      expect(physical).toEqual([]);
      expect(trace.some((r) => r.fault === FEEDBACK_MISMATCH)).toBe(false);
    });

    it.each(motors)("motor %s: feedback lost while running", (device) => {
      expectCaught(device, ["running"], (sim) => sim.setJams([{ sensor: sensorOf(device, "running"), value: false }]));
    });

    it.each(motors)("motor %s: feedback comes on while stopped (started by itself, or a welded contactor)", (device) => {
      expectCaught(device, ["stopped"], (sim) => sim.setJams([{ sensor: sensorOf(device, "running"), value: true }]));
    });

    it.each(motors)("motor %s: a feedback glitch while running, shorter than the debounce time, is ignored", (device) => {
      expectGlitchIgnored(device, ["running"], false);
    });
  }
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
