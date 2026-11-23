import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, type StationIR } from "@tejun/compiler";
import { StationRuntime, Ton, VERSION } from "@tejun/runtime";

function irOf(file: string): StationIR {
  const text = readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8");
  return check(`examples/${file}`, text).ir!;
}

describe("Ton", () => {
  it("starts on a rising IN, reaches Q at PT, and resets on IN = FALSE", () => {
    const t = new Ton();
    t.call(0, true, 100);
    expect([t.q, t.et]).toEqual([false, 0]);
    t.call(60, true);
    expect([t.q, t.et]).toEqual([false, 60]);
    t.call(100, true);
    expect([t.q, t.et]).toEqual([true, 100]);
    t.call(500, true);
    expect([t.q, t.et]).toEqual([true, 100]);
    t.call(520, false);
    expect([t.q, t.et]).toEqual([false, 0]);
    t.call(540, true);
    t.call(600, true);
    expect([t.q, t.et]).toEqual([false, 60]);
  });
});

describe("StationRuntime", () => {
  it("re-exports the version", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("runs the press feeder cycle", () => {
    const rt = new StationRuntime(irOf("press_feeder.tejun"));
    const base = { estop_ok: true, part_present: false, clamp_ext_ls: false, clamp_ret_ls: false, press_force: 0 };
    let t = 0;
    const scan = (inputs: Partial<typeof base>) => rt.scan({ ...base, ...inputs }, (t += 20));

    expect(scan({}).outputs).toEqual({ clamp_out: false, clamp_in: true, conveyor: false }); // Home retracts
    scan({ clamp_ret_ls: true }); // step done
    expect(scan({ clamp_ret_ls: true }).state).toBe("Idle");
    expect(rt.pos).toEqual({ clamp: "retracted" });
    expect(scan({ clamp_ret_ls: true, part_present: true }).outputs.clamp_out).toBe(true);
    expect(rt.state).toBe("Clamp");
    expect(rt.pos).toEqual({ clamp: "moving" });
  });

  it("raises a step timeout and goes to Stopped with every output off", () => {
    const rt = new StationRuntime(irOf("press_feeder.tejun"));
    let last;
    for (let t = 20; t <= 2100; t += 20) {
      last = rt.scan({ estop_ok: true, clamp_ret_ls: false, press_force: 0 }, t);
      if (last.fault) break;
    }
    expect(last!.fault).toBe("HOME_TIMEOUT");
    expect(last!.state).toBe("Stopped");
    expect(Object.values(last!.outputs).every((v) => !v)).toBe(true);
    expect(last!.events[0]).toMatchObject({ kind: "fault", cause: { kind: "step", sensor: "clamp_ret_ls", ms: 2000 } });
  });

  it("stops on E-stop, and a runtime monitor raises its fault", () => {
    const estop = new StationRuntime(irOf("press_feeder.tejun"));
    const r = estop.scan({ estop_ok: false, press_force: 0 }, 20);
    expect(r.state).toBe("Stopped");
    expect(r.fault).toBeUndefined();
    expect(r.events).toContainEqual({ kind: "stopped", by: "handler", condition: "not estop_ok" });

    const overload = new StationRuntime(irOf("press_feeder.tejun"));
    const o = overload.scan({ estop_ok: true, press_force: 45 }, 20);
    expect(o.fault).toBe("OVERLOAD");
    expect(overload.faultNumber()).toBe(1);
  });
});
