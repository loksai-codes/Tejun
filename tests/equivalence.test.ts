// The simulator must behave exactly like the generated PLC code. For every
// example this runs the IR interpreter (packages/runtime) and the generated
// Structured Text (through tests/support/st-interpreter.ts) on the same
// inputs, scan by scan, and compares every output, the state number and the
// fault number:
//   - the example scenario, and the scenario with each device sensor jammed
//     OFF and ON (driven by the simulated machine)
//   - seeded random inputs, including random sensor values no real machine
//     would produce

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build, type StationIR } from "@tejun/compiler";
import { Plant, StationRuntime, parseScenario, simulate, type Inputs, type Jam } from "@tejun/runtime";
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
    expect(result.trace.length).toBeGreaterThan(10);
  });

  it("random inputs, 40 seeds", () => {
    let scans = 0;
    const statesSeen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
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
