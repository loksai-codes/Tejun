// Built-in device kinds. The checker, IR, codegen and runtime all read these
// definitions, so a device behaves the same everywhere.

export interface DeviceParam {
  name: string;
  /** Which kind of signal the parameter must be wired to. */
  direction: "input" | "output";
  /** What the signal does, for help messages. */
  description: string;
}

export interface DeviceAction {
  /** Output parameter switched ON while the action runs. */
  drive: string;
  /** Input parameter that confirms the action finished. */
  done: string;
}

export interface DeviceKind {
  name: string;
  params: readonly DeviceParam[];
  actions: Readonly<Record<string, DeviceAction>>;
  /** State name -> input parameter that confirms it. */
  states: Readonly<Record<string, string>>;
}

/** Double-acting pneumatic cylinder with a limit switch at each end. */
export const CYLINDER: DeviceKind = {
  name: "Cylinder",
  params: [
    { name: "extend", direction: "output", description: "the valve output that extends the cylinder" },
    { name: "retract", direction: "output", description: "the valve output that retracts the cylinder" },
    { name: "at_ext", direction: "input", description: "the sensor that confirms the cylinder is extended" },
    { name: "at_ret", direction: "input", description: "the sensor that confirms the cylinder is retracted" },
  ],
  actions: {
    extend: { drive: "extend", done: "at_ext" },
    retract: { drive: "retract", done: "at_ret" },
  },
  states: {
    extended: "at_ext",
    retracted: "at_ret",
  },
};

export const DEVICE_KINDS: ReadonlyMap<string, DeviceKind> = new Map([[CYLINDER.name, CYLINDER]]);

/**
 * Built-in fault raised when a device's sensors disagree with its tracked
 * position for at least POSITION_DEBOUNCE_MS: two end sensors ON at once, or
 * the device is tracked at an end whose sensor is OFF (moved by hand, sensor
 * failed). Programs cannot use this name for their own faults (T0102).
 */
export const POSITION_MISMATCH = "POSITION_MISMATCH";

/** How long a position mismatch must last before POSITION_MISMATCH is raised. */
export const POSITION_DEBOUNCE_MS = 100;
