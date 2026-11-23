import { build, type BuildResult, type Diagnostic, type StationIR } from "@tejun/compiler";
import { Plant, Simulation, parseScenario, type Jam, type TimedEvent } from "@tejun/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor, type EditorHandle } from "./Editor";
import { EXAMPLES } from "./examples";
import { formatEvent, t, type Lang } from "./logic/i18n";
import { LiveClock } from "./logic/live";
import { toMarkers } from "./logic/markers";
import { StationView } from "./StationView";

const FILE = "program.tejun";
const CHECK_DELAY_MS = 200;
const LOG_LIMIT = 400;
const SPEEDS = [1, 0.25];

type Tab = "log" | "st" | "scenario";

interface Good {
  ir: StationIR;
  st: string;
}

export function App() {
  const [lang, setLang] = useState<Lang>("en");
  const [exampleId, setExampleId] = useState(EXAMPLES[0]!.id);
  const [source, setSource] = useState(EXAMPLES[0]!.program);
  const [scenarioText, setScenarioText] = useState(EXAMPLES[0]!.scenario);
  const [result, setResult] = useState<BuildResult>(() => build(FILE, EXAMPLES[0]!.program));
  const [good, setGood] = useState<Good | undefined>(() => goodOf(result));
  const [playScenario, setPlayScenario] = useState(true);
  const [jam, setJam] = useState("");
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>("log");
  const [, setFrame] = useState(0);
  const sim = useRef<Simulation | null>(null);
  const clock = useRef(new LiveClock());
  const editor = useRef<EditorHandle | null>(null);
  const redraw = () => setFrame((f) => f + 1);

  // Re-check shortly after typing stops; remember the last clean program.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = build(FILE, source);
      setResult(next);
      const g = goodOf(next);
      if (g) setGood(g);
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);

  const hasErrors = result.diagnostics.length > 0;
  const markers = useMemo(() => toMarkers(result.diagnostics, result.source, lang), [result, lang]);
  const owned = useMemo(() => (good ? new Plant(good.ir).owned : new Map<string, string>()), [good]);
  const scenario = useMemo(
    () => (good ? parseScenario(scenarioText, good.ir, owned) : undefined),
    [good, scenarioText, owned],
  );
  const jams = useMemo(() => parseJam(jam), [jam]);
  // Scenario edits and jams take effect on Reset (jams also live, below), so
  // typing in the scenario box does not restart a running simulation.
  const latest = useRef({ scenario, jams });
  latest.current = { scenario, jams };

  const reset = useCallback(() => {
    setRunning(false);
    clock.current.reset();
    const { scenario: parsed, jams: currentJams } = latest.current;
    sim.current = good
      ? new Simulation(good.ir, {
          untilMs: Infinity,
          keepTrace: false,
          jams: currentJams,
          ...(playScenario && parsed?.scenario ? { scenario: parsed.scenario } : {}),
        })
      : null;
    redraw();
  }, [good, playScenario]);

  // A new clean program (or scenario setting) starts a fresh simulation.
  useEffect(reset, [reset]);
  useEffect(() => {
    sim.current?.setJams(jams);
  }, [jams]);
  useEffect(() => {
    if (hasErrors) setRunning(false);
  }, [hasErrors]);

  // Live loop: real time -> scans.
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const s = sim.current;
      if (!s) return;
      const scans = clock.current.scansFor(now - last, speed, s.scanMs);
      last = now;
      for (let i = 0; i < scans && !s.finished; i++) s.step();
      redraw();
      if (s.finished) {
        setRunning(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, speed]);

  const run = () => {
    if (sim.current?.finished) reset();
    setRunning(true);
  };

  const loadExample = (id: string) => {
    const next = EXAMPLES.find((e) => e.id === id)!;
    setExampleId(id);
    setSource(next.program);
    setScenarioText(next.scenario);
    setJam("");
  };

  const example = EXAMPLES.find((e) => e.id === exampleId);
  const edited = example !== undefined && example.program !== source;
  const s = sim.current;
  const ir = good?.ir;

  return (
    <div className="app" lang={lang}>
      <header className="topbar">
        <div className="brand">
          <h1>{t("title", lang)}</h1>
          <p>{t("tagline", lang)}</p>
        </div>
        <div className="topbar-controls">
          <label className="field">
            <span>{t("example", lang)}</span>
            <select value={exampleId} onChange={(e) => loadExample(e.target.value)}>
              {EXAMPLES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name[lang]}
                  {e.id === exampleId && edited ? ` ${t("custom", lang)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={() => setLang(lang === "en" ? "ja" : "en")}>
            {t("language", lang)}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="pane" aria-label="Tejun source">
          <Editor value={source} onChange={setSource} markers={markers} label="Tejun source" handle={editor} />
          <Diagnostics
            diagnostics={result.diagnostics}
            lang={lang}
            onSelect={(d) => editor.current?.reveal(d.span.line, d.span.col)}
          />
        </section>

        <section className="pane" aria-label="Simulator">
          <div className="card sim">
            {ir && s ? (
              <>
                <div className="sim-status">
                  <span>
                    {t("stateLabel", lang)} <strong>{s.last?.state ?? ir.initialState}</strong>
                  </span>
                  <span className={s.last?.fault ? "fault" : undefined}>
                    {t("faultLabel", lang)} <strong>{s.last?.fault ?? t("none", lang)}</strong>
                  </span>
                  <span>
                    {t("time", lang)} <strong>{((s.last?.timeMs ?? 0) / 1000).toFixed(2)} s</strong>
                  </span>
                </div>
                <div className="station-scroll">
                  <StationView ir={ir} positions={s.plant.positions()} last={s.last} lang={lang} />
                </div>
                <Controls
                  lang={lang}
                  running={running}
                  canRun={!hasErrors}
                  onRun={run}
                  onPause={() => setRunning(false)}
                  onReset={reset}
                  speed={speed}
                  onSpeed={setSpeed}
                  jam={jam}
                  onJam={setJam}
                  ir={ir}
                  owned={owned}
                />
                {hasErrors ? <p className="hint">{t("fixErrorsToRun", lang)}</p> : null}
                <IoPanel
                  ir={ir}
                  sim={s}
                  owned={owned}
                  follows={playScenario ? (scenario?.scenario?.follows ?? []) : []}
                  jams={jams}
                  lang={lang}
                  onChange={redraw}
                />
              </>
            ) : (
              <p className="hint">{t("fixErrorsToRun", lang)}</p>
            )}
          </div>

          <div className="card tabs-card">
            <div className="tabs" role="tablist">
              {(["log", "st", "scenario"] as const).map((id) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {t(id === "log" ? "eventLog" : id === "st" ? "structuredText" : "scenario", lang)}
                </button>
              ))}
            </div>
            <div className="tab-body" role="tabpanel">
              {tab === "log" ? <EventLog events={s?.events ?? []} ir={ir} lang={lang} /> : null}
              {tab === "st" ? <StPanel st={good?.st} stale={hasErrors} lang={lang} /> : null}
              {tab === "scenario" ? (
                <ScenarioPanel
                  text={scenarioText}
                  onText={setScenarioText}
                  play={playScenario}
                  onPlay={setPlayScenario}
                  errors={scenario?.errors ?? []}
                  lang={lang}
                />
              ) : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function goodOf(result: BuildResult): Good | undefined {
  return result.ir && result.st ? { ir: result.ir, st: result.st } : undefined;
}

function parseJam(value: string): Jam[] {
  if (!value) return [];
  const [sensor, state] = value.split("=");
  return [{ sensor: sensor!, value: state === "on" }];
}

function Diagnostics({ diagnostics, lang, onSelect }: { diagnostics: readonly Diagnostic[]; lang: Lang; onSelect(d: Diagnostic): void }) {
  return (
    <div className="diagnostics" role="status" aria-live="polite">
      <h2>
        {t("errors", lang)} <span className="count">{diagnostics.length}</span>
      </h2>
      {diagnostics.length === 0 ? (
        <p className="ok">{t("noErrors", lang)}</p>
      ) : (
        <ul>
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button type="button" onClick={() => onSelect(d)}>
                <span className="code">{d.code}</span>
                <span className="where">
                  {d.span.line}:{d.span.col}
                </span>
                <span className="message">{lang === "ja" ? d.messageJa : d.message}</span>
                {d.help ? <span className="help">help: {d.help}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ControlsProps {
  lang: Lang;
  running: boolean;
  canRun: boolean;
  onRun(): void;
  onPause(): void;
  onReset(): void;
  speed: number;
  onSpeed(speed: number): void;
  jam: string;
  onJam(jam: string): void;
  ir: StationIR;
  owned: ReadonlyMap<string, string>;
}

function Controls(p: ControlsProps) {
  const sensors = p.ir.signals
    .filter((s) => s.direction === "input" && s.type === "bool" && !s.safety)
    .sort((a, b) => Number(p.owned.has(b.name)) - Number(p.owned.has(a.name)));
  return (
    <div className="controls">
      {p.running ? (
        <button type="button" className="button" onClick={p.onPause}>
          ⏸ {t("pause", p.lang)}
        </button>
      ) : (
        <button type="button" className="button primary" onClick={p.onRun} disabled={!p.canRun}>
          ▶ {t("run", p.lang)}
        </button>
      )}
      <button type="button" className="button" onClick={p.onReset}>
        ⟲ {t("reset", p.lang)}
      </button>
      <label className="field">
        <span>{t("speed", p.lang)}</span>
        <select value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))}>
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("jam", p.lang)}</span>
        <select value={p.jam} onChange={(e) => p.onJam(e.target.value)}>
          <option value="">{t("noJam", p.lang)}</option>
          {sensors.flatMap((s) => [
            <option key={`${s.name}=off`} value={`${s.name}=off`}>
              {s.name} — {t("stuckOff", p.lang)}
            </option>,
            <option key={`${s.name}=on`} value={`${s.name}=on`}>
              {s.name} — {t("stuckOn", p.lang)}
            </option>,
          ])}
        </select>
      </label>
    </div>
  );
}

interface IoPanelProps {
  ir: StationIR;
  sim: Simulation;
  owned: ReadonlyMap<string, string>;
  follows: readonly { input: string; output: string }[];
  jams: readonly Jam[];
  lang: Lang;
  onChange(): void;
}

function IoPanel({ ir, sim, owned, follows, jams, lang, onChange }: IoPanelProps) {
  const current = (name: string) => sim.last?.inputs[name] ?? sim.inputValue(name);
  const inputs = ir.signals.filter((s) => s.direction === "input");
  const outputs = ir.signals.filter((s) => s.direction === "output" && s.type === "bool");
  const set = (name: string, value: boolean | number) => {
    sim.setInput(name, value);
    onChange();
  };
  return (
    <div className="io-grid">
      <div>
        <h3>{t("inputs", lang)}</h3>
        <ul className="io-list">
          {inputs.map((s) => {
            const value = current(s.name);
            const jammed = jams.find((j) => j.sensor === s.name);
            const follow = follows.find((f) => f.input === s.name);
            const via = jammed
              ? t(jammed.value ? "stuckOn" : "stuckOff", lang)
              : (owned.get(s.name) ?? (follow ? `${t("follows", lang)} ${follow.output}` : undefined));
            const title = s.label ? `${s.label} (${s.address})` : s.address;
            if (s.type === "real") {
              return (
                <li key={s.name}>
                  <label className="real-input" title={title}>
                    {s.name}
                    <input
                      type="number"
                      value={Number(value ?? 0)}
                      min={s.range?.min}
                      max={s.range?.max}
                      onChange={(e) => set(s.name, Number(e.target.value))}
                    />
                    {s.unit ?? ""}
                  </label>
                </li>
              );
            }
            if (s.safety) {
              const pressed = value === false;
              return (
                <li key={s.name}>
                  <button type="button" className="estop" aria-pressed={pressed} title={title} onClick={() => set(s.name, pressed)}>
                    {t("estop", lang)} · {s.name}: {pressed ? t("estopPressed", lang) : t("estopRelease", lang)}
                  </button>
                </li>
              );
            }
            return (
              <li key={s.name}>
                <button
                  type="button"
                  className="input-switch"
                  aria-pressed={value === true}
                  disabled={via !== undefined}
                  title={title}
                  onClick={() => set(s.name, value !== true)}
                >
                  <span className="dot" aria-hidden="true" />
                  {s.name}
                  {via ? <span className="via">({via})</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <h3>{t("outputs", lang)}</h3>
        <ul className="io-list">
          {outputs.map((s) => {
            const on = sim.last?.outputs[s.name] === true;
            return (
              <li key={s.name}>
                <span className={`output-lamp${on ? " on" : ""}`} title={s.label ? `${s.label} (${s.address})` : s.address}>
                  <span className="dot" aria-hidden="true" />
                  {s.name}
                  <span className="visually-hidden">{on ? "ON" : "OFF"}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function EventLog({ events, ir, lang }: { events: readonly TimedEvent[]; ir: StationIR | undefined; lang: Lang }) {
  const end = useRef<HTMLLIElement>(null);
  const units = useMemo(() => new Map((ir?.signals ?? []).map((s) => [s.name, s.unit])), [ir]);
  // Block body on purpose: newer browsers return a Promise from scrollIntoView,
  // and React would try to call a returned value as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [events.length]);
  if (events.length === 0) return <p className="hint">{t("noEvents", lang)}</p>;
  const shown = events.slice(-LOG_LIMIT);
  return (
    <ol className="log">
      {shown.map((e, i) => (
        <li key={events.length - shown.length + i} className={e.event.kind}>
          <time>{(e.timeMs / 1000).toFixed(3)}</time>
          {formatEvent(e.event, lang, units)}
        </li>
      ))}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

function StPanel({ st, stale, lang }: { st: string | undefined; stale: boolean; lang: Lang }) {
  const [copied, setCopied] = useState(false);
  if (!st) return <p className="hint">{t("fixErrorsToRun", lang)}</p>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(st);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <div className="st-toolbar">
        <span>{stale ? t("stLastGood", lang) : ""}</span>
        <button type="button" className="button" onClick={copy}>
          {copied ? t("copied", lang) : t("copy", lang)}
        </button>
      </div>
      <pre className="code">{st}</pre>
    </>
  );
}

interface ScenarioPanelProps {
  text: string;
  onText(text: string): void;
  play: boolean;
  onPlay(play: boolean): void;
  errors: readonly { line: number; message: string; messageJa: string; help?: string }[];
  lang: Lang;
}

function ScenarioPanel({ text, onText, play, onPlay, errors, lang }: ScenarioPanelProps) {
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={play} onChange={(e) => onPlay(e.target.checked)} />
        {t("useScenario", lang)}
      </label>
      <p className="hint">{t("scenarioHelp", lang)}</p>
      <textarea className="scenario" value={text} spellCheck={false} onChange={(e) => onText(e.target.value)} aria-label={t("scenario", lang)} />
      {errors.length > 0 ? (
        <ul className="scenario-errors">
          {errors.map((e, i) => (
            <li key={i}>
              {e.line}: {lang === "ja" ? e.messageJa : e.message}
              {e.help ? ` — ${e.help}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
