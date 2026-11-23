import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, type StationIR } from "@tejun/compiler";
import { Plant, formatScenarioErrors, parseScenario, parseTime } from "@tejun/runtime";

function irOf(file: string): StationIR {
  const text = readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8");
  return check(`examples/${file}`, text).ir!;
}

const press = irOf("press_feeder.tejun");
const pick = irOf("pick_place.tejun");
const parse = (text: string, ir = press) => parseScenario(text, ir, new Plant(ir).owned);

describe("Plant", () => {
  it("starts retracted and moves a cylinder after its travel time", () => {
    const plant = new Plant(press, 300);
    expect(plant.sensors()).toEqual({ clamp_ext_ls: false, clamp_ret_ls: true });
    plant.advance({ clamp_out: true, clamp_in: false }, 20);
    expect(plant.sensors()).toEqual({ clamp_ext_ls: false, clamp_ret_ls: false });
    for (let i = 0; i < 14; i++) plant.advance({ clamp_out: true }, 20);
    expect(plant.sensors()).toEqual({ clamp_ext_ls: true, clamp_ret_ls: false });
  });

  it("holds position with both outputs off or both on", () => {
    const plant = new Plant(press, 100);
    plant.advance({ clamp_out: true }, 50);
    plant.advance({}, 500);
    plant.advance({ clamp_out: true, clamp_in: true }, 500);
    expect(plant.sensors()).toEqual({ clamp_ext_ls: false, clamp_ret_ls: false });
  });

  it("lists the sensors it drives", () => {
    expect([...new Plant(pick).owned]).toEqual([
      ["z_down_ls", "z"],
      ["z_up_ls", "z"],
      ["x_out_ls", "x"],
      ["x_home_ls", "x"],
    ]);
  });
});

describe("parseTime", () => {
  it.each([
    ["500ms", 500],
    ["1.5 s", 1500],
    ["2s", 2000],
    ["10", undefined],
    ["1 min", undefined],
  ])("%s", (text, ms) => expect(parseTime(text)).toBe(ms));
});

describe("parseScenario", () => {
  it("parses sets, follows and until, sorted by time", () => {
    const { scenario, errors } = parse(
      ["# comment", "at 2 s part_present = off", "at 1 s part_present = ON  # trailing", "at 1 s press_force = 12.5 kN", "until 5 s"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(scenario).toEqual({
      sets: [
        { atMs: 1000, signal: "part_present", value: true, line: 3 },
        { atMs: 1000, signal: "press_force", value: 12.5, line: 4 },
        { atMs: 2000, signal: "part_present", value: false, line: 2 },
      ],
      follows: [],
      untilMs: 5000,
    });
  });

  it("parses follow with and without a delay", () => {
    const { scenario } = parse("follow vacuum_ok = vacuum after 100 ms\nfollow part_ready = vacuum", pick);
    expect(scenario?.follows).toEqual([
      { input: "vacuum_ok", output: "vacuum", delayMs: 100, line: 1 },
      { input: "part_ready", output: "vacuum", delayMs: 0, line: 2 },
    ]);
  });

  it("reports every error with its line, in English and Japanese", () => {
    const { scenario, errors } = parse(
      [
        "at 1 s part_presnt = on",
        "at 1 s conveyor = on",
        "at 1 s clamp_ext_ls = on",
        "at 1 s part_present = maybe",
        "at 1 s press_force = 12 N",
        "at 1 s press_force = 12",
        "wait 2 s",
      ].join("\n"),
    );
    expect(scenario).toBeUndefined();
    expect(errors.map((e) => [e.line, e.message, e.help])).toEqual([
      [1, "unknown input `part_presnt`", "did you mean `part_present`?"],
      [2, "`conveyor` is an output; scenarios set inputs", undefined],
      [3, "`clamp_ext_ls` is driven by the simulated device `clamp`", "to make it stick, run with `--jam clamp_ext_ls` (stuck OFF) or `--jam clamp_ext_ls=on`"],
      [4, "`part_present` is bool; expected on or off, found `maybe`", undefined],
      [5, "`press_force` is in kN, but the value has N", "write `12 kN`"],
      [6, "`press_force` is in kN, but the value has no unit", "write `12 kN`"],
      [7, "cannot understand this line", "lines look like `at 1 s part_present = on`, `follow vacuum_ok = vacuum after 100 ms` or `until 10 s`"],
    ]);
    expect(errors.every((e) => e.messageJa.length > 0)).toBe(true);
  });

  it("rejects setting an input that follows an output", () => {
    const { errors } = parse("follow vacuum_ok = vacuum\nat 1 s vacuum_ok = on", pick);
    expect(errors.map((e) => e.line)).toEqual([2]);
  });

  it("formats errors like compiler diagnostics", () => {
    const { errors } = parse("at 1 s part_presnt = on");
    expect(formatScenarioErrors(errors, "examples/x.scenario")).toBe(
      [
        "error: examples/x.scenario:1: unknown input `part_presnt`",
        "  = help: did you mean `part_present`?",
        "  = 日本語: 不明な入力 `part_presnt`",
        "",
      ].join("\n"),
    );
  });
});
