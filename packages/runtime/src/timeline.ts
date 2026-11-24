// Readable timeline for `tejun run`.

import type { StationIR } from "@tejun/compiler";
import type { FaultCause } from "./station.js";
import type { Jam, SimulationResult, TimelineEvent } from "./simulate.js";

export interface TimelineHeader {
  scenarioPath: string | undefined;
  jams: readonly Jam[];
}

const EVENT_WIDTH = 34;

export function formatTimeline(ir: StationIR, result: SimulationResult, header: TimelineHeader): string {
  const units = new Map(ir.signals.map((s) => [s.name, s.unit]));
  const parts = [
    `${ir.name}${ir.label ? ` ${ir.label}` : ""}`,
    `scenario ${header.scenarioPath ?? "none"}`,
    `scan ${result.scanMs} ms`,
  ];
  if (header.jams.length > 0) {
    parts.push(`jammed: ${header.jams.map((j) => `${j.sensor} (stuck ${j.value ? "ON" : "OFF"})`).join(", ")}`);
  }

  const lines = [parts.join(" · "), "   time  event"];
  for (const { timeMs, event } of result.events) {
    lines.push(`${seconds(timeMs).padStart(7)}  ${describe(event, units)}`.trimEnd());
  }

  const { end } = result;
  const fault = end.fault ? `, fault ${end.fault}` : "";
  const faultJa = end.fault ? `、故障 ${end.fault}` : "";
  const limit = end.reason === "time limit";
  lines.push(`end at ${seconds(end.timeMs)} s: ${end.state}${fault}${limit ? " (time limit)" : ""}`);
  lines.push(`終了 ${seconds(end.timeMs)} 秒: ${end.state}${faultJa}${limit ? " (時間制限)" : ""}`);
  return lines.join("\n") + "\n";
}

/** One event as timeline text, e.g. `Idle -> Clamp    outputs: clamp_out`. */
export function describeEvent(event: TimelineEvent, units: ReadonlyMap<string, string | undefined>): string {
  return describe(event, units);
}

function describe(event: TimelineEvent, units: ReadonlyMap<string, string | undefined>): string {
  switch (event.kind) {
    case "start":
      return withOutputs(`start in ${event.state}`, event.outputs);
    case "input": {
      const value =
        typeof event.value === "boolean"
          ? ` ${event.value ? "ON" : "OFF"}`
          : ` = ${event.value}${units.get(event.signal) ? ` ${units.get(event.signal)}` : ""}`;
      return `${event.signal}${value} (${event.source})`;
    }
    case "fault":
      return `FAULT ${event.number} ${event.fault}: ${cause(event.cause)}`;
    case "transition":
      return withOutputs(`${event.from} -> ${event.to}${event.reason ? ` (${event.reason})` : ""}`, event.outputs);
    case "violation":
      return `!! INTERLOCK VIOLATED: ${event.interlock} (a bug in Tejun; please report it)`;
  }
}

function cause(c: FaultCause): string {
  switch (c.kind) {
    case "step":
      return `${c.sensor} not ON within ${c.ms} ms`;
    case "wait":
      return `no transition within ${c.ms} ms`;
    case "monitor":
      return `${c.condition} is false`;
    case "mismatch":
      return `${c.device} sensors (${sensorList(c.sensors)}) disagree with its tracked ${c.tracked} (${c.state}) for ${c.ms} ms`;
  }
}

/** `clamp_ext_ls OFF, clamp_ret_ls ON` */
export function sensorList(sensors: Readonly<Record<string, boolean>>): string {
  return Object.entries(sensors).map(([s, v]) => `${s} ${v ? "ON" : "OFF"}`).join(", ");
}

function withOutputs(text: string, outputs: string[] | undefined): string {
  if (outputs === undefined) return text;
  return `${text.padEnd(EVENT_WIDTH)} outputs: ${outputs.length > 0 ? outputs.join(", ") : "all OFF"}`;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
