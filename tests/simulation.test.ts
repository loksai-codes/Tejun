import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, type StationIR } from "@tejun/compiler";
import { Simulation } from "@tejun/runtime";

const press: StationIR = check(
  "examples/press_feeder.tejun",
  readFileSync(new URL("../examples/press_feeder.tejun", import.meta.url), "utf8"),
).ir!;

describe("Simulation (step by step)", () => {
  it("advances one scan at a time and can run until Stopped", () => {
    const sim = new Simulation(press, { untilMs: Infinity, keepTrace: false });
    sim.step();
    sim.step();
    expect(sim.timeMs).toBe(40);
    expect(sim.last?.state).toBe("Idle");
    expect(sim.trace).toEqual([]);
    expect(sim.finished).toBe(false);
  });

  it("takes manual input values, labelled as manual", () => {
    const sim = new Simulation(press, { untilMs: Infinity });
    for (let i = 0; i < 5; i++) sim.step();
    sim.setInput("part_present", true);
    const events = sim.step();
    expect(events.map((e) => e.event)).toContainEqual({ kind: "input", signal: "part_present", value: true, source: "manual" });
    expect(sim.last?.state).toBe("Clamp");
    expect(sim.inputValue("part_present")).toBe(true);
  });

  it("applies jams changed while running", () => {
    const sim = new Simulation(press, { untilMs: Infinity });
    for (let i = 0; i < 5; i++) sim.step();
    sim.setJams([{ sensor: "clamp_ext_ls", value: false }]);
    sim.setInput("part_present", true);
    while (!sim.finished) sim.step();
    expect(sim.last).toMatchObject({ state: "Stopped", fault: "CLAMP_TIMEOUT" });
  });

  it("reports device positions from 0 (retracted) to 1 (extended)", () => {
    const sim = new Simulation(press, { untilMs: Infinity, travelMs: 100 });
    for (let i = 0; i < 3; i++) sim.step();
    sim.setInput("part_present", true);
    sim.step(); // enters Clamp and switches clamp_out on; the clamp moves 20 ms
    sim.step();
    sim.step();
    expect(sim.plant.positions().clamp).toBeCloseTo(0.6); // 3 × 20 ms of 100 ms travel
  });
});
