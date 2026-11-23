// A simulated machine ("plant") for `tejun run`: it moves the devices in
// response to the outputs and produces their sensor signals, so a scenario
// only has to script the other inputs.
//
// Cylinder: starts retracted. While its extend output is ON (and retract is
// OFF) it travels toward extended; after `travelMs` the extended sensor turns
// ON. Leaving an end turns that end's sensor OFF. With both outputs OFF it
// holds its position, like a double-acting valve.

import type { StationIR } from "@tejun/compiler";

export const DEFAULT_TRAVEL_MS = 300;

interface Cylinder {
  device: string;
  extend: string;
  retract: string;
  atExt: string;
  atRet: string;
  /** 0 = fully retracted, travelMs = fully extended. */
  progress: number;
}

export class Plant {
  readonly travelMs: number;
  /** Sensor name -> the device that drives it. */
  readonly owned: ReadonlyMap<string, string>;
  private readonly cylinders: Cylinder[];

  constructor(ir: StationIR, travelMs = DEFAULT_TRAVEL_MS) {
    this.travelMs = travelMs;
    this.cylinders = ir.devices
      .filter((d) => d.kind === "Cylinder")
      .map((d) => ({
        device: d.name,
        extend: d.wiring.extend!,
        retract: d.wiring.retract!,
        atExt: d.wiring.at_ext!,
        atRet: d.wiring.at_ret!,
        progress: 0,
      }));
    this.owned = new Map(this.cylinders.flatMap((c) => [[c.atExt, c.device], [c.atRet, c.device]] as const));
  }

  /** Current values of every device-driven sensor. */
  sensors(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const c of this.cylinders) {
      out[c.atExt] = c.progress >= this.travelMs;
      out[c.atRet] = c.progress <= 0;
    }
    return out;
  }

  /** Device name -> how far it is extended, from 0 (retracted) to 1 (extended). */
  positions(): Record<string, number> {
    return Object.fromEntries(this.cylinders.map((c) => [c.device, c.progress / this.travelMs]));
  }

  /** Move the devices for `dtMs` with the given outputs. */
  advance(outputs: Readonly<Record<string, boolean>>, dtMs: number): void {
    for (const c of this.cylinders) {
      const ext = outputs[c.extend] === true;
      const ret = outputs[c.retract] === true;
      if (ext && !ret) c.progress = Math.min(this.travelMs, c.progress + dtMs);
      if (ret && !ext) c.progress = Math.max(0, c.progress - dtMs);
    }
  }
}
