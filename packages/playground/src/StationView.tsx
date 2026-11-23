// SVG picture of any station: each Cylinder with its rod moving in real time,
// its valve outputs and end sensors; then the state graph with the current
// state highlighted. Built from the IR, so it works for every program.

import type { StationIR } from "@tejun/compiler";
import type { ScanRecord } from "@tejun/runtime";
import { t, type Lang } from "./logic/i18n";

const WIDTH = 640;
const ROW = 74;
const STATE_W = 104;
const STATE_H = 30;
const STATES_PER_ROW = 5;

interface Props {
  ir: StationIR;
  positions: Readonly<Record<string, number>>;
  last: ScanRecord | undefined;
  lang: Lang;
}

export function StationView({ ir, positions, last, lang }: Props) {
  const cylinders = ir.devices.filter((d) => d.kind === "Cylinder");
  const states = [...ir.states.map((s) => s.name), "Stopped"];
  const current = last?.state ?? ir.initialState;
  const isOn = (signal: string) => last?.outputs[signal] === true || last?.inputs[signal] === true;

  const devicesTop = 24;
  const statesTop = devicesTop + Math.max(cylinders.length, 1) * ROW + 28;
  const stateRows = Math.ceil(states.length / STATES_PER_ROW);
  const height = statesTop + 20 + stateRows * (STATE_H + 18);

  return (
    <svg
      className="station-svg"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="img"
      aria-label={`${ir.name}: ${t("stateLabel", lang)} ${current}`}
    >
      <text x={0} y={14} className="muted">
        {t("devices", lang)}
      </text>
      {cylinders.length === 0 ? (
        <text x={0} y={devicesTop + 30} className="muted">
          —
        </text>
      ) : null}
      {cylinders.map((d, i) => (
        <Cylinder
          key={d.name}
          y={devicesTop + i * ROW}
          name={d.name}
          position={positions[d.name] ?? 0}
          extend={d.wiring.extend!}
          retract={d.wiring.retract!}
          atExt={d.wiring.at_ext!}
          atRet={d.wiring.at_ret!}
          isOn={isOn}
        />
      ))}

      <text x={0} y={statesTop} className="muted">
        {t("states", lang)}
      </text>
      {states.map((name, i) => {
        const col = i % STATES_PER_ROW;
        const row = Math.floor(i / STATES_PER_ROW);
        const x = col * (STATE_W + 22);
        const y = statesTop + 12 + row * (STATE_H + 18);
        const active = name === current;
        const stopped = name === "Stopped";
        const fill = active ? (stopped ? "var(--stopped)" : "var(--state-active)") : "var(--state)";
        return (
          <g key={name}>
            {col > 0 && !stopped ? (
              <text x={x - 15} y={y + STATE_H / 2 + 4} className="muted">
                ›
              </text>
            ) : null}
            <rect
              x={x}
              y={y}
              width={STATE_W}
              height={STATE_H}
              rx={6}
              fill={fill}
              stroke={stopped ? "var(--stopped)" : "var(--border)"}
              strokeDasharray={stopped && !active ? "4 3" : undefined}
            />
            <text
              x={x + STATE_W / 2}
              y={y + STATE_H / 2 + 4}
              textAnchor="middle"
              style={{ fill: active ? "#fff" : undefined, fontWeight: active ? 600 : 400 }}
            >
              {name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface CylinderProps {
  y: number;
  name: string;
  position: number;
  extend: string;
  retract: string;
  atExt: string;
  atRet: string;
  isOn(signal: string): boolean;
}

function Cylinder({ y, name, position, extend, retract, atExt, atRet, isOn }: CylinderProps) {
  const barrelX = 150;
  const barrelW = 170;
  const stroke = 150;
  const rodEnd = barrelX + barrelW + position * stroke;
  const mid = y + 26;
  return (
    <g>
      <text x={0} y={mid + 4} style={{ fontWeight: 600 }}>
        {name}
      </text>
      <text x={0} y={mid + 20} className="muted">
        Cylinder
      </text>

      {/* valve outputs */}
      <Arrow x={barrelX - 34} y={mid - 14} dir="right" on={isOn(extend)} label={extend} />
      <Arrow x={barrelX - 34} y={mid + 6} dir="left" on={isOn(retract)} label={retract} />

      {/* barrel, piston, rod, head */}
      <rect x={barrelX} y={mid - 14} width={barrelW} height={28} rx={4} fill="var(--surface-2)" stroke="var(--metal-dark)" />
      <rect x={barrelX + 6 + position * (barrelW - 22)} y={mid - 11} width={10} height={22} fill="var(--metal-dark)" />
      <rect x={barrelX + barrelW} y={mid - 4} width={rodEnd - barrelX - barrelW} height={8} fill="var(--metal)" />
      <rect x={rodEnd} y={mid - 16} width={14} height={32} rx={3} fill="var(--metal-dark)" />

      {/* end sensors */}
      <Led x={barrelX + barrelW + 7} y={mid + 30} on={isOn(atRet)} label={atRet} labelSide="left" />
      <Led x={barrelX + barrelW + stroke + 7} y={mid + 30} on={isOn(atExt)} label={atExt} labelSide="right" />
    </g>
  );
}

function Arrow({ x, y, dir, on, label }: { x: number; y: number; dir: "left" | "right"; on: boolean; label: string }) {
  const path = dir === "right" ? `M ${x} ${y + 4} h 20 l -5 -4 m 5 4 l -5 4` : `M ${x + 20} ${y + 4} h -20 l 5 -4 m -5 4 l 5 4`;
  return (
    <g>
      <title>{`${label}: ${on ? "ON" : "OFF"}`}</title>
      <path d={path} stroke={on ? "var(--lamp-on)" : "var(--lamp-off)"} strokeWidth={3} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Led({ x, y, on, label, labelSide }: { x: number; y: number; on: boolean; label: string; labelSide: "left" | "right" }) {
  return (
    <g>
      <title>{`${label}: ${on ? "ON" : "OFF"}`}</title>
      <circle cx={x} cy={y - 4} r={5} fill={on ? "var(--led-on)" : "var(--lamp-off)"} />
      <text x={labelSide === "left" ? x - 9 : x + 9} y={y} textAnchor={labelSide === "left" ? "end" : "start"} className="muted" style={{ fontSize: 11 }}>
        {label}
      </text>
    </g>
  );
}
