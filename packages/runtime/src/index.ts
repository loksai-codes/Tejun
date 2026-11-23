// Tejun runtime: scan-cycle interpreter over the same IR the ST codegen reads,
// plus a simulated machine and scenario files for `tejun run`.

export { VERSION } from "@tejun/compiler";
export { Ton } from "./timer.js";
export {
  StationRuntime,
  STOPPED,
  UNKNOWN,
  MOVING,
  type Inputs,
  type ScanEvent,
  type ScanResult,
  type FaultCause,
} from "./station.js";
