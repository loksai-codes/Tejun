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
export { Plant, DEFAULT_TRAVEL_MS } from "./plant.js";
export {
  parseScenario,
  parseTime,
  formatScenarioErrors,
  type Scenario,
  type ScenarioSet,
  type ScenarioFollow,
  type ScenarioError,
} from "./scenario.js";
export {
  simulate,
  Simulation,
  DEFAULT_SCAN_MS,
  DEFAULT_UNTIL_MS,
  type Jam,
  type SimulationOptions,
  type SimulationResult,
  type TimelineEvent,
  type TimedEvent,
  type ScanRecord,
} from "./simulate.js";
export { formatTimeline, describeEvent, type TimelineHeader } from "./timeline.js";
