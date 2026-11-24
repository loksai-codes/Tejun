// Golden tests for the state-graph IR of each example. The JSON files in
// tests/golden/ are the reviewable form of each station's state graph.
// Spans are left out so the files only change when the meaning changes.
//
// To regenerate on purpose:
//   Git Bash:    UPDATE_GOLDEN=1 npm test
//   PowerShell:  $env:UPDATE_GOLDEN=1; npm test; Remove-Item Env:UPDATE_GOLDEN

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, outputsOn } from "@tejun/compiler";

const examplesDir = new URL("../examples/", import.meta.url);
const goldenDir = new URL("./golden/", import.meta.url);
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".tejun"));
const update = process.env.UPDATE_GOLDEN === "1";

const withoutSpans = (key: string, value: unknown) => (key === "span" ? undefined : value);

function irOf(file: string) {
  const text = readFileSync(new URL(file, examplesDir), "utf8");
  const result = check(`examples/${file}`, text);
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}

describe("IR golden files", () => {
  it.each(examples)("%s", (file) => {
    const actual = JSON.stringify(irOf(file), withoutSpans, 2) + "\n";
    const goldenUrl = new URL(file.replace(/\.tejun$/, ".ir.json"), goldenDir);
    if (update) writeFileSync(goldenUrl, actual, "utf8");
    expect(actual).toBe(readFileSync(goldenUrl, "utf8").replace(/\r\n/g, "\n"));
  });
});

describe("IR", () => {
  it("is not built when the program has errors", () => {
    const text = readFileSync(new URL("press_feeder.tejun", examplesDir), "utf8");
    const result = check("x.tejun", text.replace("-> Press", "-> Pres"));
    expect(result.diagnostics).not.toEqual([]);
    expect(result.ir).toBeUndefined();
  });

  it("turns a device action into a step with its drive output and done sensor", () => {
    const ir = irOf("press_feeder.tejun");
    const clamp = ir.states.find((s) => s.name === "Clamp")!;
    expect(clamp.step).toMatchObject({
      kind: "device",
      drive: "clamp_out",
      done: "clamp_ext_ls",
      timeout: { kind: "within", ms: 2000, fault: "CLAMP_TIMEOUT" },
    });
    expect(outputsOn(clamp)).toEqual(["clamp_out"]);
    expect(outputsOn(ir.states.find((s) => s.name === "Idle")!)).toEqual(["conveyor"]);
  });

  it("numbers faults in order of first appearance, without duplicates, then POSITION_MISMATCH", () => {
    expect(irOf("press_feeder.tejun").faults).toEqual([
      "OVERLOAD",
      "HOME_TIMEOUT",
      "CLAMP_TIMEOUT",
      "RELEASE_TIMEOUT",
      "POSITION_MISMATCH",
    ]);
    expect(irOf("pick_place.tejun").faults).toEqual([
      "Z_DOWN_TIMEOUT",
      "NO_VACUUM",
      "Z_UP_TIMEOUT",
      "X_OUT_TIMEOUT",
      "VACUUM_STUCK",
      "X_HOME_TIMEOUT",
      "POSITION_MISMATCH",
    ]);
  });

  it("adds the position check and each device's position sensors", () => {
    const ir = irOf("press_feeder.tejun");
    expect(ir.positionCheck).toEqual({ fault: "POSITION_MISMATCH", debounceMs: 100 });
    expect(ir.devices[0]!.sensors).toEqual({ extended: "clamp_ext_ls", retracted: "clamp_ret_ls" });
  });

  it("keeps every state's transitions pointing at a real state or Stopped", () => {
    for (const file of examples) {
      const ir = irOf(file);
      const names = new Set([...ir.states.map((s) => s.name), "Stopped"]);
      for (const s of ir.states) for (const t of s.transitions) expect(names).toContain(t.target);
    }
  });
});
