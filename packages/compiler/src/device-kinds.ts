// Built-in device kinds. The checker, IR, codegen, runtime and interlock
// proof all read these definitions, so a device behaves the same everywhere.
//
// A device kind is a contract:
//   - params: the signals it is wired to
//   - actions: used as a state's step; the `drive` output is ON for the whole
//     state, and the action is done once its target state's sensor confirms it
//   - states: used in conditions; each is "this input has this value", and is
//     true only while the device is *tracked* in that state
//   - release: for devices that act only while driven (a motor), the state
//     they fall back to once no state drives them, confirmed by its sensor
//   - mismatchFault: the built-in fault raised when the sensors disagree with
//     the tracked state for MISMATCH_DEBOUNCE_MS

export interface DeviceParam {
  name: string;
  /** Which kind of signal the parameter must be wired to. */
  direction: "input" | "output";
  /** What the signal does, for help messages. */
  description: string;
}

export interface DeviceAction {
  /** Output parameter switched ON for the whole state that runs the action. */
  drive: string;
  /** The state the action reaches; its sensor confirms the action finished. */
  done: string;
}

export interface DeviceState {
  /** Input parameter that confirms the state. */
  sensor: string;
  /** The value of that input in this state. */
  value: boolean;
}

export interface DeviceKind {
  name: string;
  params: readonly DeviceParam[];
  actions: Readonly<Record<string, DeviceAction>>;
  states: Readonly<Record<string, DeviceState>>;
  /**
   * Undefined: the device keeps its state when no state drives it (a
   * double-acting cylinder holds its position). Otherwise, leaving a state
   * that drives it puts it in `via` until `state`'s sensor confirms `state`.
   */
  release?: { via: string; state: string };
  /** Built-in fault for sensors that disagree with the tracked state. */
  mismatchFault: string;
  /** What the tracked state is called in messages: "position" or "state". */
  tracked: string;
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
    extend: { drive: "extend", done: "extended" },
    retract: { drive: "retract", done: "retracted" },
  },
  states: {
    extended: { sensor: "at_ext", value: true },
    retracted: { sensor: "at_ret", value: true },
  },
  mismatchFault: "POSITION_MISMATCH",
  tracked: "position",
};

/**
 * Motor with a run command and a running feedback (a speed monitor: ON at
 * speed, OFF at standstill). It runs only in states whose step is `run`.
 */
export const MOTOR: DeviceKind = {
  name: "Motor",
  params: [
    { name: "run", direction: "output", description: "the output that runs the motor (contactor or drive enable)" },
    { name: "feedback", direction: "input", description: "the running feedback: ON while the motor runs, OFF at standstill" },
  ],
  actions: {
    run: { drive: "run", done: "running" },
  },
  states: {
    running: { sensor: "feedback", value: true },
    stopped: { sensor: "feedback", value: false },
  },
  release: { via: "stopping", state: "stopped" },
  mismatchFault: "FEEDBACK_MISMATCH",
  tracked: "state",
};

export const DEVICE_KINDS: ReadonlyMap<string, DeviceKind> = new Map([
  [CYLINDER.name, CYLINDER],
  [MOTOR.name, MOTOR],
]);

/**
 * Built-in fault of a Cylinder: its sensors disagree with its tracked
 * position (two end sensors ON, the tracked end's sensor OFF, or the start
 * sensor still ON while moving away). Programs cannot raise it (T0102).
 */
export const POSITION_MISMATCH = CYLINDER.mismatchFault;

/**
 * Built-in fault of a Motor: running with its feedback OFF (feedback lost),
 * or stopped with its feedback ON. Programs cannot raise it (T0102).
 */
export const FEEDBACK_MISMATCH = MOTOR.mismatchFault;

/** Every built-in device fault name. */
export const BUILTIN_FAULTS: readonly string[] = [...new Set([...DEVICE_KINDS.values()].map((k) => k.mismatchFault))];

/** How long a disagreement must last before the device's mismatch fault is raised. */
export const MISMATCH_DEBOUNCE_MS = 100;
