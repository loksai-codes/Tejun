// The example programs and scenarios from the repo's examples/ folder,
// bundled into the page at build time.

import conveyorProgram from "../../../examples/conveyor_sorter.tejun?raw";
import conveyorScenario from "../../../examples/conveyor_sorter.scenario?raw";
import pickProgram from "../../../examples/pick_place.tejun?raw";
import pickScenario from "../../../examples/pick_place.scenario?raw";
import pressProgram from "../../../examples/press_feeder.tejun?raw";
import pressScenario from "../../../examples/press_feeder.scenario?raw";
import stationProgram from "../../../examples/press_station.tejun?raw";
import stationScenario from "../../../examples/press_station.scenario?raw";

export interface Example {
  id: string;
  name: { en: string; ja: string };
  program: string;
  scenario: string;
}

export const EXAMPLES: readonly Example[] = [
  { id: "press_feeder", name: { en: "Press feeder", ja: "プレス送り" }, program: pressProgram, scenario: pressScenario },
  { id: "conveyor_sorter", name: { en: "Conveyor sorter", ja: "コンベア仕分け" }, program: conveyorProgram, scenario: conveyorScenario },
  { id: "pick_place", name: { en: "Pick and place", ja: "ピック&プレース" }, program: pickProgram, scenario: pickScenario },
  {
    id: "press_station",
    name: { en: "Press station (motor + cylinders)", ja: "プレスステーション (モータ+シリンダ)" },
    program: stationProgram,
    scenario: stationScenario,
  },
];
